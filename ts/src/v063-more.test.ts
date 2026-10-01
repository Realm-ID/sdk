import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { createMemorySessionStore, sessionStoreConformance, lockKey, type SessionStateStore } from "./session-store.js";
import { createScopeMiddleware } from "./scope.js";
import { AUD, BASE, REALM, claimsFor, drive, fakeIssuer, jsonRes, makeSigner, MockRes } from "./v063-fixture.test.js";

const NOW = 1_800_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(opts: { store?: SessionStateStore; mw?: Record<string, unknown> } = {}) {
  const { publicJwk, sign } = await makeSigner();
  const f = fakeIssuer(publicJwk);
  const store = opts.store ?? createMemorySessionStore({ now: () => Date.now() });
  const realm = createRealm({
    realmId: REALM, apiKey: "rk_live_x", baseUrl: BASE, origin: "https://app.test", audience: AUD,
    fetch: f.fetch, clock: () => new Date(NOW * 1000), sessionStore: store,
  });
  const mw = realm.middleware({ exemptPaths: ["/health"], ...(opts.mw ?? {}) });
  const get = (token: string, url = "/api/x") => drive(mw as never, { url, headers: { authorization: `Bearer ${token}` } });
  return { f, sign, realm, mw, store, get };
}
const cookie = (...rts: string[]) => ({ cookie: rts.map((r) => `realmid_refresh=${r}`).join("; ") });
const refreshReq = (headers: Record<string, string>, tenant = "acme") => ({ url: "/token", method: "POST", headers, body: { tenant_id: tenant } });
const lastToken = (c: string[]) => c.map((x) => /realmid_refresh=([^;]*)/.exec(x)?.[1]).filter(Boolean).pop();

test("SPEC6_7_5 #33 sessionStoreConformance passes on the in-memory store", async () => {
  await sessionStoreConformance((clock) => createMemorySessionStore({ now: clock.now }));
});

test("SPEC10_1_4a #51 loser with no outcome in 3 s: 503 refresh in progress, issuer not called", async () => {
  const s = await setup();
  const held = await s.store.acquireRefreshLock(await lockKey("rt0"), 60_000);
  assert.equal(held.acquired, true);
  const r = await drive(s.mw as never, refreshReq(cookie("rt0")));
  assert.equal(r.res.statusCode, 503);
  assert.equal((r.res.json["error"] as Record<string, unknown>)["message"], "refresh in progress");
  assert.equal(s.f.count("/auth/token"), 0);
  await held.release();
});

test("SPEC10_1_4a #53 a request that is abandoned mid-mint still completes; a retry gets the stored outcome", async () => {
  const s = await setup();
  s.f.token = async () => {
    await sleep(60);
    return jsonRes(200, { access_token: await s.sign(claimsFor(NOW + 1)), refresh_token: "rt-1", expires_in: 900, tenant_id: "acme", role: "m" });
  };
  void drive(s.mw as never, refreshReq(cookie("rt0"))); // never awaited: the client has gone
  await sleep(200);
  const retry = await drive(s.mw as never, refreshReq(cookie("rt0")));
  assert.equal(retry.res.statusCode, 200);
  assert.equal(s.f.count("/auth/token"), 1);
  assert.equal(lastToken(retry.res.setCookie), "rt-1");
});

test("SPEC10_1_4a #54 mint bounded at 10 s: error outcome stored, lock released", { timeout: 20_000 }, async () => {
  const s = await setup();
  s.f.token = () => new Promise<Response>(() => {}); // hangs forever
  const r = await drive(s.mw as never, refreshReq(cookie("rt0")));
  assert.equal(r.res.statusCode, 504);
  const again = await s.store.acquireRefreshLock(await lockKey("rt0"), 1000);
  assert.equal(again.acquired, true, "lock released");
  await again.release();
});

test("SPEC10_1_4b #62a tab churn: each switch = one 401 revoked, one /token, one successful retry; nobody logged out", async () => {
  const s = await setup();
  let n = 0;
  s.f.token = async () => {
    n++;
    return jsonRes(200, { access_token: await s.sign(claimsFor(NOW + n, { jti: `j${n}` })), refresh_token: `rt-${n}`, expires_in: 900, tenant_id: "acme", role: "m" });
  };
  const tabs = [await s.sign(claimsFor(NOW - 10, { jti: "a" })), await s.sign(claimsFor(NOW - 10, { jti: "b" }))];
  let rt = "rt-start";
  // One tab refreshes first so the session has a not-before mark at all.
  const first = await drive(s.mw as never, refreshReq(cookie(rt)));
  rt = lastToken(first.res.setCookie)!;
  tabs[0] = String(first.res.json["access_token"]);
  let refreshes = 0;
  let rejections = 0;
  for (let k = 0; k < 10; k++) {
    const i = k % 2;
    let r = await s.get(tabs[i]!);
    if (r.res.statusCode === 401) {
      assert.equal(r.res.json["revoked"], true);
      rejections++;
      const rr = await drive(s.mw as never, refreshReq(cookie(rt)));
      assert.equal(rr.res.statusCode, 200);
      refreshes++;
      rt = lastToken(rr.res.setCookie)!;
      tabs[i] = String(rr.res.json["access_token"]);
      r = await s.get(tabs[i]!);
    }
    assert.equal(r.res.statusCode, 200, `switch ${k}`);
  }
  assert.equal(s.f.count("/auth/token"), refreshes + 1);
  assert.equal(refreshes, rejections);
  assert.ok(refreshes >= 9, `expected a refresh per switch, got ${refreshes}`);
  assert.equal(s.f.count("/auth/logout"), 0);
});

test("SPEC10_2 cookie candidates #44,58,61c: every candidate tried in order, first keys the lock, rotation judged against the minter, logout revokes all", async () => {
  const s = await setup();
  const seen: string[] = [];
  s.f.token = async (body) => {
    const rt = String(body["refresh_token"]);
    seen.push(rt);
    if (rt === "stale") return jsonRes(401, { error: { code: "unauthorized", message: "refresh_invalid" } });
    return jsonRes(200, { access_token: await s.sign(claimsFor(NOW + 5)), refresh_token: rt, expires_in: 900, tenant_id: "acme", role: "m" });
  };
  const prev = await s.sign(claimsFor(NOW - 100));
  const r = await drive(s.mw as never, refreshReq(cookie("stale", "live", "stale", "x", "y")));
  assert.equal(r.res.statusCode, 200);
  assert.deepEqual(seen, ["stale", "live"], "dedup, in order, stops at the first that mints");
  assert.equal((await s.get(prev)).nextCalled, true, "echoed minter token = not rotated = no recordRefresh");

  const l = await setup();
  const out: string[] = [];
  l.f.logout = (b) => { out.push(String(b["refresh_token"])); return jsonRes(200, { status: "ok", sid: `s-${b["refresh_token"]}` }); };
  await drive(l.mw as never, { url: "/logout", method: "POST", headers: cookie("a", "b") });
  assert.deepEqual(out, ["a", "b"]);
  for (const sid of ["s-a", "s-b"]) assert.equal((await l.get(await l.sign(claimsFor(NOW, { sid, jti: sid })))).res.statusCode, 401);
});

test("SPEC10_2 cookieDomain move: host-only twin evicted on write; cookieDomainMigrateFrom evicted; current scope never deleted", async () => {
  const s = await setup({ mw: { cookieDomain: ".example.com", cookieDomainMigrateFrom: [".old.example.com", "example.com"] } });
  s.f.token = async () => jsonRes(200, { access_token: await s.sign(claimsFor(NOW + 1)), refresh_token: "rt-1", expires_in: 900, tenant_id: "acme", role: "m" });
  const r = await drive(s.mw as never, refreshReq(cookie("rt0")));
  const cs = r.res.setCookie;
  assert.ok(cs.some((c) => /^realmid_refresh=rt-1;.*Domain=\.example\.com/.test(c)));
  assert.ok(cs.some((c) => /^realmid_refresh=;/.test(c) && !/Domain=/.test(c) && /Max-Age=0/.test(c)), "host-only deletion");
  assert.ok(cs.some((c) => /^realmid_refresh=;.*Domain=old\.example\.com/.test(c)));
  assert.ok(!cs.some((c) => /^realmid_refresh=;.*Domain=example\.com/.test(c)), "current scope is never deleted");
});

test("SPEC10_2_paths + SPEC11_4_1 through the middleware: mfa {name}, /x/** bare prefix, exempt braces literal, scope chain", async () => {
  const s = await setup({ mw: { mfaProtectedPaths: ["/orders/{id}", "/m/**"], exemptPaths: ["/hooks/{id}", "/open/**"] } });
  const tok = await s.sign(claimsFor(NOW));
  assert.equal((await s.get(tok, "/orders/42")).res.statusCode, 412);
  assert.equal((await s.get(tok, "/orders/")).nextCalled, true);
  assert.equal((await s.get(tok, "/orders/42/items")).nextCalled, true);
  assert.equal((await s.get(tok, "/m")).res.statusCode, 412, "bare /m is protected");
  assert.equal((await drive(s.mw as never, { url: "/open" })).nextCalled, true, "bare /open exempt");
  assert.equal((await drive(s.mw as never, { url: "/open/a/b" })).nextCalled, true);
  assert.equal((await drive(s.mw as never, { url: "/openx" })).res.statusCode, 401);
  assert.equal((await drive(s.mw as never, { url: "/hooks/{id}" })).nextCalled, true, "literal");
  assert.equal((await drive(s.mw as never, { url: "/hooks/abc" })).res.statusCode, 401, "braces are not a placeholder in exemptPaths");

  const scoped = createScopeMiddleware([{ path: "/x/**", scopes: ["a:a"] }, { path: "/o/{id}", scopes: ["a:a"] }]);
  const through = async (url: string, scope: string) => {
    const t = await s.sign(claimsFor(NOW, { scope }));
    const a = await s.get(t, url);
    if (!a.nextCalled) return a.res.statusCode;
    const res = new MockRes();
    let passed = false;
    scoped({ method: "GET", url, realmid: a.reqObj["realmid"] as never }, res, () => { passed = true; });
    return passed ? 200 : res.statusCode;
  };
  assert.equal(await through("/x", "a:a"), 200, "scope rule /x/** covers bare /x");
  assert.equal(await through("/x", "z:z"), 403);
  assert.equal(await through("/o/42", "a:a"), 200);
  assert.equal(await through("/o/", "a:a"), 403, "{id} never matches an empty segment");
  assert.equal(await through("/o/42/", "a:a"), 403);
});
