import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { RealmError } from "./errors.js";

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

/**
 * Recorder that auto-services the `POST /auth/login` mint as the
 * first call (returning a fresh platform token). Subsequent handlers fire
 * for the actual user-facing call. Tests can inspect every recorded call.
 */
function recorder(handlers: Array<(rec: Recorded) => Response | Promise<Response>>): {
  fetch: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let i = 0;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers);
    let body: unknown;
    if (init?.body) {
      try { body = JSON.parse(String(init.body)); } catch { body = init.body; }
    }
    const rec: Recorded = { url, method: init?.method ?? "GET", headers, body };
    calls.push(rec);

    // ADR-051: /auth/login is dual-purpose. The bootstrap mints the
    // platform session via grant_type=platform_api_key; user-grant
    // logins (provider_token, password, otp_internal) flow to the
    // per-test handler.
    if (url.endsWith("/auth/login")) {
      const gt = (body as { grant_type?: string } | undefined)?.grant_type;
      if (gt === "platform_api_key") {
        return new Response(JSON.stringify({
          status: "ok",
          subject_type: "platform",
          refresh_token: "rtok-platform",
          access_token: "pt_test_abc",
          expires_in: 300,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    const h = handlers[i++] ?? handlers[handlers.length - 1]!;
    return h(rec);
  }) as typeof fetch;
  return { fetch, calls };
}

const REALM_ID = "01HREALM";
const API_KEY = "rk_live_test123";

test("auth.login: happy path mints platform token first, then logs in", async () => {
  const { fetch, calls } = recorder([
    () => new Response(JSON.stringify({
      access_token: "at",
      refresh_token: "rt",
      expires_in: 900,
      user: { id: "u1", email: "a@b" },
      tenants: [{ id: "t1", role: "owner" }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const realm = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch, origin: "https://app.example" });
  const out = await realm.auth.login({ method: "firebase", providerToken: "id_xyz" });
  assert.equal(out.accessToken, "at");
  assert.equal(out.refreshToken, "rt");
  assert.equal(out.tenants[0]!.id, "t1");

  // Two outbound calls (ADR-051): platform_api_key bootstrap on
  // /auth/login, then the user-grant /auth/login.
  assert.equal(calls.length, 2);
  assert.match(calls[0]!.url, /\/auth\/login$/);
  // Raw API key travels in the body, not as a bearer.
  assert.equal(calls[0]!.headers.get("authorization"), null);
  assert.equal((calls[0]!.body as { grant_type: string }).grant_type, "platform_api_key");

  assert.match(calls[1]!.url, /\/auth\/login$/);
  assert.equal(calls[1]!.headers.get("authorization"), "Bearer pt_test_abc");
  assert.equal(calls[1]!.headers.get("origin"), "https://app.example");
  const body = calls[1]!.body as Record<string, unknown>;
  assert.equal(body["realm_id"], REALM_ID);
  assert.equal(body["method"], "firebase");
  assert.equal(body["provider_token"], "id_xyz");
  assert.equal(body["custom_claims"], undefined, "login must not carry custom_claims (SPEC §4.1)");
});

test("auth.login: mfa_required surfaces challenge token", async () => {
  const { fetch } = recorder([
    () => new Response(JSON.stringify({
      error: { code: "mfa_required", message: "MFA required" },
      mfa_challenge_token: "ch_token_123",
      methods: ["totp"],
    }), { status: 412, headers: { "content-type": "application/json" } }),
  ]);
  const realm = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch, origin: "https://app.example" });
  await assert.rejects(
    () => realm.auth.login({ method: "firebase", providerToken: "id" }),
    (e: Error) => {
      if (!(e instanceof RealmError)) return false;
      if (e.code !== "mfa_required") return false;
      return e.details?.["mfa_challenge_token"] === "ch_token_123";
    },
  );
});

test("auth.token: rotate refresh + tenant switch", async () => {
  const { fetch, calls } = recorder([
    () => new Response(JSON.stringify({
      access_token: "at2",
      refresh_token: "rt2",
      expires_in: 900,
      tenant_id: "t2",
      role: "admin",
    }), { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const realm = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch, origin: "https://app.example" });
  const out = await realm.auth.token({ refreshToken: "rt", tenantId: "t2", customClaims: { outlet_ids: ["o1"] } });
  assert.equal(out.accessToken, "at2");
  assert.equal(out.role, "admin");
  const body = calls[1]!.body as Record<string, unknown>;
  assert.equal(body["tenant_id"], "t2");
  assert.equal(body["refresh_token"], "rt");
  const cc = body["custom_claims"] as Record<string, unknown>;
  assert.deepEqual(cc["outlet_ids"], ["o1"]);
});

test("auth.otpLogin: sends method=otp_internal + identifier + presented", async () => {
  const { fetch, calls } = recorder([
    () => new Response(JSON.stringify({
      access_token: "at", refresh_token: "rt", expires_in: 900,
      user: { id: "u-bob" }, tenants: [{ id: "t1", role: "member" }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const realm = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch, origin: "https://app.example" });
  const out = await realm.auth.otpLogin({ identifier: "+15551234567", presented: "123456" });
  assert.equal(out.accessToken, "at");
  const body = calls[1]!.body as Record<string, unknown>;
  assert.equal(body["method"], "otp_internal");
  assert.equal(body["identifier"], "+15551234567");
  assert.equal(body["presented"], "123456");
});

test("auth.mfaVerifyOtp: routes through /auth/mfa/verify with method=otp_internal", async () => {
  const { fetch, calls } = recorder([
    () => new Response(JSON.stringify({
      access_token: "at2", refresh_token: "rt2", expires_in: 900,
      user: { id: "u" }, tenants: [],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const realm = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch, origin: "https://app.example" });
  await realm.auth.mfaVerifyOtp({ mfaToken: "ch_9", presented: "654321" });
  assert.match(calls[1]!.url, /\/auth\/mfa\/verify$/);
  const body = calls[1]!.body as Record<string, unknown>;
  assert.equal(body["method"], "otp_internal");
  assert.equal(body["mfa_challenge_token"], "ch_9");
  assert.equal(body["code"], "654321");
});

test("auth.logout: returns ok", async () => {
  const { fetch, calls } = recorder([
    () => new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const realm = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch, origin: "https://app.example" });
  const out = await realm.auth.logout({ refreshToken: "rt" });
  assert.equal(out.status, "ok");
  assert.match(calls[1]!.url, /\/auth\/logout$/);
});

test("auth.listSessions: decodes issuer sessionDTO fields incl. last_seen_at", async () => {
  // Mirrors issuer/internal/httpapi/sessions.go sessionDTO on the wire: the
  // last-used timestamp field is `last_seen_at`, NOT `last_used_at`, and
  // timestamps are unix-seconds JSON numbers. `listSessions` returns the
  // parsed server JSON unmapped, so SessionInfo must carry the wire names.
  const { fetch, calls } = recorder([
    () => new Response(JSON.stringify({
      sessions: [{
        id: "sess-1",
        origin: "https://app.realmid.dev",
        device_name: "laptop",
        created_at: 1_751_241_600,
        last_seen_at: 1_751_245_200,
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const realm = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch, origin: "https://app.example" });
  const list = await realm.auth.listSessions("u-jwt");
  // userBearer path uses the JWT directly — no platform-token bootstrap.
  assert.match(calls[0]!.url, /\/auth\/sessions$/);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, "sess-1");
  assert.equal(list[0]!.created_at, 1_751_241_600);
  assert.equal(list[0]!.last_seen_at, 1_751_245_200, "last-used must decode from the wire last_seen_at field");
});
