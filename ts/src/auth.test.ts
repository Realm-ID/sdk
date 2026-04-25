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
    const h = handlers[i++] ?? handlers[handlers.length - 1]!;
    return h(rec);
  }) as typeof fetch;
  return { fetch, calls };
}

const REALM_ID = "01HREALM";

test("auth.login: happy path", async () => {
  const { fetch, calls } = recorder([
    () => new Response(JSON.stringify({
      access_token: "at",
      refresh_token: "rt",
      expires_in: 900,
      user: { id: "u1", email: "a@b" },
      tenants: [{ id: "t1", role: "owner" }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const realm = createRealm({ realmId: REALM_ID, baseUrl: "https://auth.test", fetch });
  const out = await realm.auth.login({ method: "firebase", providerToken: "id_xyz" });
  assert.equal(out.accessToken, "at");
  assert.equal(out.refreshToken, "rt");
  assert.equal(out.tenants[0]!.id, "t1");

  assert.equal(calls[0]!.method, "POST");
  assert.match(calls[0]!.url, /\/auth\/login$/);
  const body = calls[0]!.body as Record<string, unknown>;
  assert.equal(body["realm_id"], REALM_ID);
  assert.equal(body["method"], "firebase");
  assert.equal(body["provider_token"], "id_xyz");
});

test("auth.login: mfa_required surfaces challenge token", async () => {
  const { fetch } = recorder([
    () => new Response(JSON.stringify({
      error: { code: "mfa_required", message: "MFA required" },
      mfa_challenge_token: "ch_token_123",
      methods: ["totp"],
    }), { status: 412, headers: { "content-type": "application/json" } }),
  ]);
  const realm = createRealm({ realmId: REALM_ID, baseUrl: "https://auth.test", fetch });
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
  const realm = createRealm({ realmId: REALM_ID, baseUrl: "https://auth.test", fetch });
  const out = await realm.auth.token({ refreshToken: "rt", tenantId: "t2" });
  assert.equal(out.accessToken, "at2");
  assert.equal(out.role, "admin");
  const body = calls[0]!.body as Record<string, unknown>;
  assert.equal(body["tenant_id"], "t2");
  assert.equal(body["refresh_token"], "rt");
});

test("auth.logout: returns ok", async () => {
  const { fetch, calls } = recorder([
    () => new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const realm = createRealm({ realmId: REALM_ID, baseUrl: "https://auth.test", fetch });
  const out = await realm.auth.logout({ refreshToken: "rt" });
  assert.equal(out.status, "ok");
  assert.match(calls[0]!.url, /\/auth\/logout$/);
});
