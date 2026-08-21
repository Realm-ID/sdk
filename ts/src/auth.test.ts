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
  // ADR-051: issuer reads grant_type/provider/token, not method/provider_token
  // — the latter never reached the server (S-01 fix).
  assert.equal(body["grant_type"], "provider_token");
  assert.equal(body["provider"], "firebase");
  assert.equal(body["token"], "id_xyz");
  assert.equal(body["method"], undefined, "deprecated `method` field must not be sent");
  assert.equal(body["provider_token"], undefined, "issuer never reads `provider_token`");
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

test("auth: decodes refresh_exp + idle_ttl onto login + token responses", async () => {
  // SPEC §4.1 refresh_exp + ADR-070 idle_ttl (sliding idle-timeout duration,
  // seconds) must map from wire snake_case onto camelCase so the BFF can size /
  // idle-expire a session. Absence must decode as undefined (→ disabled).
  const { fetch } = recorder([
    () => new Response(JSON.stringify({
      access_token: "at", refresh_token: "rt", expires_in: 900,
      refresh_exp: 1_780_000_000, idle_ttl: 1800,
      user: { id: "u1" }, tenants: [{ id: "t1", role: "owner" }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const realm = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch, origin: "https://app.example" });
  const login = await realm.auth.login({ method: "firebase", providerToken: "id_xyz" });
  assert.equal(login.refreshExp, 1_780_000_000);
  assert.equal(login.idleTtl, 1800);

  const tok = recorder([
    () => new Response(JSON.stringify({
      access_token: "at2", refresh_token: "rt2", expires_in: 900,
      refresh_exp: 1_780_000_000, idle_ttl: 1800, tenant_id: "t2", role: "admin",
    }), { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const realm2 = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch: tok.fetch, origin: "https://app.example" });
  const token = await realm2.auth.token({ refreshToken: "rt", tenantId: "t2" });
  assert.equal(token.refreshExp, 1_780_000_000);
  assert.equal(token.idleTtl, 1800);

  // Absent idle_ttl → undefined (idle timeout disabled).
  const bare = recorder([
    () => new Response(JSON.stringify({
      access_token: "at", refresh_token: "rt", expires_in: 900,
      user: { id: "u1" }, tenants: [{ id: "t1" }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const realm3 = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch: bare.fetch, origin: "https://app.example" });
  const bareLogin = await realm3.auth.login({ method: "firebase", providerToken: "id" });
  assert.equal(bareLogin.idleTtl, undefined);
});

test("auth.otpLogin: sends grant_type=otp + identifier + presented (ADR-071 §4)", async () => {
  const { fetch, calls } = recorder([
    () => new Response(JSON.stringify({
      access_token: "at", refresh_token: "rt", expires_in: 900,
      initiated_by_user_id: "u-owner",
      user: { id: "u-bob" }, tenants: [{ id: "t1", role: "member" }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const realm = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch, origin: "https://app.example" });
  const out = await realm.auth.otpLogin({ identifier: "+15551234567", presented: "123456" });
  assert.equal(out.accessToken, "at");
  // ADR-071 §8 provenance decodes onto the session.
  assert.equal(out.initiatedByUserId, "u-owner");
  const body = calls[1]!.body as Record<string, unknown>;
  assert.equal(body["grant_type"], "otp");
  // Direct cutover — the deprecated `method` field must not be sent.
  assert.equal(body["method"], undefined);
  assert.equal(body["identifier"], "+15551234567");
  assert.equal(body["presented"], "123456");
});

test("auth.mfaVerifyOtp: routes through /auth/mfa/verify with method=otp (ADR-071 §4)", async () => {
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
  assert.equal(body["method"], "otp");
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
  // The envelope is the issuer's LOCKED paged shape `{items, next_cursor,
  // total}` (httpapi.pagedSlice) — verbatim from a real response, not invented
  // here. The old fixture served `{sessions: [...]}`, a shape no issuer emits,
  // so it agreed with the SDK's decode while both disagreed with the server:
  // listSessions returned [] in production and the test passed. Confirmed
  // end-to-end by tests/sdk-e2e.
  const { fetch, calls } = recorder([
    () => new Response(JSON.stringify({
      items: [{
        id: "sess-1",
        origin: "https://app.realmid.dev",
        device_name: "laptop",
        created_at: 1_751_241_600,
        last_seen_at: 1_751_245_200,
      }],
      next_cursor: null,
      total: 1,
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

test("auth.login: sends the ADR-062 X-Device-Name header, and only on the user grant", async () => {
  // The issuer reads X-Device-Name on POST /auth/login only
  // (issuer/docs/swagger.yaml, maxLength 120); it sanitizes and caps the value
  // server-side, so the SDK sends it raw. TS carried the READ half
  // (SessionInfo.device_name) since ADR-062 and never had the send half —
  // sdk/TODO.md recorded this gap as Java-only, which was wrong.
  const { fetch, calls } = recorder([
    () => new Response(JSON.stringify({
      access_token: "at-1", refresh_token: "rt-1", expires_in: 600,
      user: { id: "u1" }, tenants: [],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const realm = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch, origin: "https://app.example" });
  await realm.auth.login({ method: "firebase", providerToken: "tok", deviceName: "akshat-mbp" });

  const bootstrap = calls[0]!;
  const login = calls[1]!;
  assert.equal(login.headers.get("x-device-name"), "akshat-mbp");
  // The bootstrap is an M2M mint that records no device label; sending the
  // operator's hostname there leaks it onto a credential session for nothing.
  assert.equal(bootstrap.headers.get("x-device-name"), null,
    "the platform bootstrap must not carry the device label");
});

test("auth.login: omits X-Device-Name when no device name is given", async () => {
  // POSITIVE CONTROL for the test above — an unconditionally-set header would
  // satisfy it. Absent must mean no header, not an empty one: the issuer treats
  // a present empty value as a supplied label.
  const { fetch, calls } = recorder([
    () => new Response(JSON.stringify({
      access_token: "at-1", refresh_token: "rt-1", expires_in: 600,
      user: { id: "u1" }, tenants: [],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const realm = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch, origin: "https://app.example" });
  await realm.auth.login({ method: "firebase", providerToken: "tok" });
  assert.equal(calls[1]!.headers.has("x-device-name"), false);
});

test("auth.listSessions: still decodes the legacy flat {sessions: [...]} shape", async () => {
  // Deliberate tolerance, mirroring Go's decodeSessionPage: partner mocks and
  // pre-envelope issuers emit the flat shape. Kept as a SEPARATE test so the
  // real wire shape above is the one the primary assertion rests on — the
  // reverse arrangement is what hid the defect for as long as it lasted.
  const { fetch } = recorder([
    () => new Response(JSON.stringify({
      sessions: [{ id: "legacy-1", created_at: 1_751_241_600 }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const realm = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch, origin: "https://app.example" });
  const list = await realm.auth.listSessions("u-jwt");
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, "legacy-1");
});

test("auth.login: a device label the transport cannot carry is stripped, not fatal", async () => {
  // undici throws `Headers.append: "..." is an invalid header value` for a C0
  // control, surfacing as a `network` RealmError — so "send it raw and let the
  // server sanitize" was wrong for exactly the input sanitizing exists for: the
  // request never left. Found by tests/sdk-e2e against a real issuer.
  // The 120-char CAP is deliberately NOT applied here; that stays the server's.
  const { fetch, calls } = recorder([
    () => new Response(JSON.stringify({
      access_token: "at-1", refresh_token: "rt-1", expires_in: 600,
      user: { id: "u1" }, tenants: [],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const realm = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch, origin: "https://app.example" });
  const long = "x".repeat(200);
  await realm.auth.login({
    method: "firebase",
    providerToken: "tok",
    deviceName: "rogue\nname" + long,
  });
  assert.equal(calls[1]!.headers.get("x-device-name"), "roguename" + long,
    "control characters removed; length left to the server");
});

test("auth.login: a label made ENTIRELY of control characters sends no header", async () => {
  // The stripped value is empty, and an empty header is a supplied label as far
  // as the issuer is concerned — so it must be omitted, not sent blank.
  const { fetch, calls } = recorder([
    () => new Response(JSON.stringify({
      access_token: "at-1", refresh_token: "rt-1", expires_in: 600,
      user: { id: "u1" }, tenants: [],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const realm = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch, origin: "https://app.example" });
  await realm.auth.login({ method: "firebase", providerToken: "tok", deviceName: "\n\n" });
  assert.equal(calls[1]!.headers.has("x-device-name"), false);
});
