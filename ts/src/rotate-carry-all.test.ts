import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createMemorySessionStore } from "./session-store.js";
import { createRealm } from "./realm.js";
import { isPlatformMint } from "./auth-mint-helpers.test.js";

// SPEC4_2_carry_all (sdk/SPEC.md §4.2, audit-fixes critic-sdk rows 1, 2, 5): EVERY failure after the
// first rotating mint carries R1; on the middleware refresh route it answers 503 (or the issuer's own
// non-401 status), never 401 and never a bare 500; a waiter for a different tenant gets the 503 retry
// hand-over (§10.1 step 4a), never the winner's handler error.

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

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: Record<string, unknown>) => `${b64({ alg: "RS256", kid: "k" })}.${b64({ exp: 4102444800, ...payload })}.sig`;
const A1 = jwt({ sub: "u-1" });
const boom = () => { throw new Error("handler down"); };

interface Opts {
  hook?: () => unknown; productRoles?: () => unknown; scopes?: () => unknown; customClaims?: () => unknown;
  firstAccess?: string; secondStatus?: number; secondCode?: string;
}

function rig(o: Opts) {
  const presented: string[] = [];
  const realm = createRealm({
    sessionStore: createMemorySessionStore(), realmId: "r1", apiKey: "rk_live_x",
    baseUrl: "https://auth.test", origin: "https://app.test", tokenDelivery: "body",
    onIdentityResolved: o.hook as never, productRoles: o.productRoles as never, scopes: o.scopes as never, customClaims: o.customClaims as never,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (isPlatformMint(url, init)) {
        return new Response(JSON.stringify({ status: "ok", subject_type: "platform", refresh_token: "rp", access_token: "pt_x", expires_in: 300 }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/auth/token")) {
        presented.push(String(body["refresh_token"]));
        const n = presented.length;
        if (n === 2 && o.secondStatus) {
          return new Response(JSON.stringify({ error: { code: o.secondCode ?? "server_error", message: "refused" } }),
            { status: o.secondStatus, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ access_token: o.firstAccess ?? A1, refresh_token: `R${n}`, expires_in: 900, subject_type: "user", tenant_id: "t1", role: "member" }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error("unexpected url " + url);
    }) as typeof fetch,
  });
  return { realm, presented };
}

async function refresh(mw: (...a: never[]) => unknown, tenant: string) {
  const res = new MockRes();
  const req = { url: "/token", method: "POST", headers: {}, body: { tenant_id: tenant, refresh_token: "R0" } };
  await (mw as (...a: unknown[]) => Promise<void>)(req, res, (e?: unknown) => { throw new Error("fell through " + String(e)); });
  return res;
}

const kinds: Array<[string, Opts, number]> = [
  ["onIdentityResolved hook refusal", { hook: boom }, 503],
  ["productRoles handler failure", { productRoles: boom }, 503],
  ["scopes handler failure", { scopes: boom }, 503],
  ["customClaims handler failure", { customClaims: boom }, 503],
  ["unreadable sub with customClaims", { customClaims: () => ({ a: 1 }), firstAccess: "not-a-jwt" }, 503],
  ["unreadable sub with only the hook", { hook: () => undefined, firstAccess: "not-a-jwt" }, 503],
  ["second mint 401", { customClaims: () => ({ a: 1 }), secondStatus: 401, secondCode: "refresh_invalid" }, 503],
  ["second mint 400 reserved_claim_key", { customClaims: () => ({ a: 1 }), secondStatus: 400, secondCode: "reserved_claim_key" }, 400],
  ["second mint 403 user_suspended", { customClaims: () => ({ a: 1 }), secondStatus: 403, secondCode: "user_suspended" }, 403],
];

for (const [name, opts, status] of kinds) {
  test(`SPEC4_2_carry_all rule 1+2: ${name} carries R1 and the refresh route answers ${status}`, async () => {
    const r = rig(opts);
    const res = await refresh(r.realm.middleware({}) as never, "t1");
    assert.equal(res.statusCode, status, `body ${res.body}`);
    assert.equal(JSON.parse(res.body).refresh_token, "R1");
    assert.ok(!res.body.includes(A1));
    // SPEC.md:1447-1449: a carried 503 body says `retry: true`.
    if (status === 503) assert.equal(JSON.parse(res.body).retry, true, `body ${res.body}`);
    // Final parity review finding 3: a carried 401 is `server_error`, never `refresh_invalid`.
    if (name === "second mint 401") assert.equal(JSON.parse(res.body).error.code, "server_error");
  });
}

test("SPEC4_2_carry_all rule 3: a waiter for a DIFFERENT tenant gets the 503 retry hand-over, never the winner's handler error", async () => {
  const r = rig({
    customClaims: async () => { await new Promise((x) => setTimeout(x, 80)); throw new Error("handler failed for tenant t1"); },
  });
  const mw = r.realm.middleware({}) as never;
  const [a, b] = await Promise.all([refresh(mw, "t1"), (async () => { await new Promise((x) => setTimeout(x, 20)); return refresh(mw, "t2"); })()]);
  assert.equal(a.statusCode, 503);
  assert.equal(b.statusCode, 503);
  const bb = JSON.parse(b.body);
  assert.equal(bb.error.message, "refresh superseded, retry");
  assert.equal(bb.retry, true);
  assert.equal(bb.refresh_token, "R1");
  assert.ok(!b.body.includes("tenant t1"), "the other tenant's error leaked");
});
