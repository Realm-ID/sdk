import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createMemorySessionStore } from "./session-store.js";
import { createRealm } from "./realm.js";
import { isPlatformMint } from "./auth-mint-helpers.test.js";

// SPEC §10.1 steps 2, 5, 5a + SPEC10_1_4_no_client_claims (owner ruling 2026-11-14, audit e-01):
// login, MFA verify and recovery refuse a body carrying custom_claims / customClaims (any value)
// with 400 custom_claims_not_accepted BEFORE any issuer call.

class MockRes {
  statusCode = 200;
  headers: Record<string, unknown> = {};
  chunks: string[] = [];
  headersSent = false;
  setHeader(n: string, v: unknown) { this.headers[n.toLowerCase()] = v; }
  getHeader(n: string) { return this.headers[n.toLowerCase()]; }
  end(c?: string) { if (c) this.chunks.push(c); this.headersSent = true; }
  writeHead(s: number) { this.statusCode = s; }
  get body() { return this.chunks.join(""); }
}

function rig() {
  const issuerCalls: string[] = [];
  const realm = createRealm({
    sessionStore: createMemorySessionStore(), realmId: "r1", apiKey: "rk_live_x",
    baseUrl: "https://auth.test", origin: "https://app.test",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (isPlatformMint(url, init)) {
        return new Response(JSON.stringify({ status: "ok", subject_type: "platform", refresh_token: "rp", access_token: "pt_x", expires_in: 300 }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      issuerCalls.push(url);
      return new Response(JSON.stringify({ error: { code: "unauthorized", message: "no" } }), { status: 401, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  return {
    issuerCalls,
    async post(path: string, body: Record<string, unknown>) {
      const res = new MockRes();
      await realm.middleware({ recoveryPath: "/mfa/recovery", originEnforcement: "off" })({ url: path, method: "POST", headers: { cookie: "realmid_refresh=rtok" }, body } as never,
        res as never, ((e?: unknown) => { throw new Error("fell through " + String(e)); }) as never);
      return res;
    },
  };
}

const routes: [string, Record<string, unknown>][] = [
  ["/login", { method: "firebase", provider_token: "x" }],
  ["/mfa/verify", { mfa_challenge_token: "c", code: "123456" }],
  ["/mfa/recovery", { mfa_challenge_token: "c", code: "abcd-efgh" }],
];
const carriers: [string, Record<string, unknown>][] = [
  ["custom_claims object", { custom_claims: { outlet_ids: ["x"] } }],
  ["customClaims object", { customClaims: { a: 1 } }],
  ["custom_claims null", { custom_claims: null }],
  ["custom_claims empty object", { custom_claims: {} }],
];
for (const [path, base] of routes) {
  for (const [label, extra] of carriers) {
    test(`${path}: ${label} is refused 400 custom_claims_not_accepted, issuer never called`, async () => {
      const r = rig();
      const res = await r.post(path, { ...base, ...extra });
      assert.equal(res.statusCode, 400);
      assert.equal(JSON.parse(res.body).error.code, "custom_claims_not_accepted");
      assert.deepEqual(r.issuerCalls, []);
    });
  }
}

test("index exports the custom-claims handler type surface (SPEC §10.2)", async () => {
  const idx = await import("./index.js");
  assert.equal(typeof idx.CustomClaimsError, "function");
  assert.equal(typeof idx.CustomClaimKeyError, "function");
});
