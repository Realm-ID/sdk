import { test } from "node:test";
import { strict as assert } from "node:assert";
import { inspect } from "node:util";
import { createMemorySessionStore } from "./session-store.js";
import { createRealm } from "./realm.js";
import { RealmError, RefreshHandedOverError } from "./errors.js";
import { CustomClaimsError, type CustomClaimsHandler } from "./custom-claims.js";
import { isPlatformMint } from "./auth-mint-helpers.test.js";

// SPEC4_2_rotate_handover (sdk/SPEC.md §4.2, audit row 2, owner decision 2026-11-14) and
// dispatcher decision (c): the fill is two mints; a failure after the first must carry the
// rotated session, never drop it.

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

interface RigOpts { handler?: CustomClaimsHandler; first?: Record<string, unknown>; secondFails?: boolean; tokenDelivery?: "cookie" | "body" }

function rig(o: RigOpts) {
  const presented: string[] = [];
  const realm = createRealm({
    sessionStore: createMemorySessionStore(), realmId: "r1", apiKey: "rk_live_x",
    baseUrl: "https://auth.test", origin: "https://app.test", customClaims: o.handler,
    ...(o.tokenDelivery ? { tokenDelivery: o.tokenDelivery } : {}),
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
        if (n === 2 && o.secondFails) {
          return new Response(JSON.stringify({ error: { code: "reserved_claim_key", message: "not allowed" } }), { status: 400, headers: { "content-type": "application/json" } });
        }
        // R0 -> R1 -> R2 ...
        return new Response(JSON.stringify({ access_token: A1, refresh_token: `R${n}`, expires_in: 900, subject_type: "user", tenant_id: "t1", role: "member", ...o.first }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error("unexpected url " + url);
    }) as typeof fetch,
  });
  return { realm, presented };
}

const failing: CustomClaimsHandler = () => { throw new Error("db down"); };

function assertCarried(e: unknown, refresh: string, cause: "handler" | "mint") {
  assert.ok(e instanceof RefreshHandedOverError, `expected RefreshHandedOverError, got ${String(e)}`);
  assert.equal(e.refreshToken(), refresh);
  assert.equal(e.accessToken(), A1);
  if (cause === "handler") assert.ok(e.cause instanceof CustomClaimsError);
  else assert.ok(e.cause instanceof RealmError && (e.cause as RealmError).code === "reserved_claim_key");
  for (const s of [e.message, String(e), JSON.stringify(e), inspect(e, { showHidden: true })]) {
    assert.ok(!s.includes(refresh) && !s.includes(A1), "token leaked into a rendering");
  }
}

test("SPEC4_2_rotate_handover: token() with a failing handler throws the carrier holding R1 and A1", async () => {
  const r = rig({ handler: failing });
  await assert.rejects(() => r.realm.auth.token({ refreshToken: "R0", tenantId: "t1" }), (e) => { assertCarried(e, "R1", "handler"); return true; });
});

test("SPEC4_2_rotate_handover: a refused second mint carries R1 with that mint's own error", async () => {
  const r = rig({ handler: () => ({ a: 1 }), secondFails: true });
  await assert.rejects(() => r.realm.auth.token({ refreshToken: "R0", tenantId: "t1" }), (e) => { assertCarried(e, "R1", "mint"); return true; });
});

test("SPEC4_2_rotate_handover + decision (c): an unreadable sub refuses with the handler error type and carries the session", async () => {
  const r = rig({ handler: () => ({ a: 1 }), first: { access_token: "not-a-jwt" } });
  await assert.rejects(() => r.realm.auth.token({ refreshToken: "R0", tenantId: "t1" }), (e) => {
    assert.ok(e instanceof RefreshHandedOverError);
    assert.equal(e.refreshToken(), "R1");
    assert.ok(e.cause instanceof CustomClaimsError);
    return true;
  });
});

test("SPEC4_2_rotate_handover: TokenManager adopts R1, hands it to the sink, and the next acquisition presents R1", async () => {
  let fail = true;
  const r = rig({ handler: () => { if (fail) throw new Error("db down"); return { a: 1 }; } });
  const sunk: string[] = [];
  const mgr = r.realm.auth.newTokenManager("R0", { tenantId: "t1", refreshSink: (t) => { sunk.push(t); } });
  await assert.rejects(() => mgr.accessToken(), (e) => e instanceof RefreshHandedOverError);
  assert.equal(mgr.refreshToken(), "R1");
  assert.deepEqual(sunk, ["R1"]);
  fail = false;
  await mgr.accessToken();
  assert.equal(r.presented[1], "R1", "the next acquisition must present the rotated token, never the spent R0");
});

for (const mode of ["cookie", "body"] as const) {
  test(`SPEC4_2_rotate_handover rule 5: middleware refresh (${mode}) hands R1 to the browser after a handler failure; a retry with the spent token does not re-mint`, async () => {
    const r = rig({ handler: failing, tokenDelivery: mode });
    const mw = r.realm.middleware({});
    const go = async () => {
      const res = new MockRes();
      const req = mode === "cookie"
        ? { url: "/token", method: "POST", headers: { cookie: "realmid_refresh=R0" }, body: { tenant_id: "t1" } }
        : { url: "/token", method: "POST", headers: {}, body: { tenant_id: "t1", refresh_token: "R0" } };
      await mw(req as never, res as never, ((e?: unknown) => { throw new Error("fell through " + String(e)); }) as never);
      return res;
    };
    for (let i = 0; i < 2; i++) {
      const res = await go();
      assert.ok(res.statusCode >= 500 || res.statusCode === 503, `status ${res.statusCode}`);
      if (mode === "cookie") assert.match(String(res.headers["set-cookie"]), /realmid_refresh=R1/);
      else assert.equal(JSON.parse(res.body).refresh_token, "R1");
    }
    assert.deepEqual(r.presented, ["R0"], "the retry must be answered from the stored outcome, never present spent R0 again");
  });
}
