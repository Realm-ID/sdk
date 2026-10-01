import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { createMemorySessionStore, type SessionStateStore } from "./session-store.js";
import { AUD, BASE, REALM, claimsFor, drive, fakeIssuer, jsonRes, makeSigner } from "./v063-fixture.test.js";

const NOW = 1_800_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(opts: { store?: SessionStateStore; tokenDelivery?: "cookie" | "body"; mfaPaths?: string[] } = {}) {
  const { publicJwk, sign } = await makeSigner();
  const f = fakeIssuer(publicJwk);
  const store = opts.store ?? createMemorySessionStore({ now: () => NOW * 1000 });
  const realm = createRealm({
    realmId: REALM, apiKey: "rk_live_x", baseUrl: BASE, origin: "https://app.test", audience: AUD,
    fetch: f.fetch, clock: () => new Date(NOW * 1000), sessionStore: store,
  });
  const mw = realm.middleware({
    tokenDelivery: opts.tokenDelivery ?? "cookie", exemptPaths: ["/health"],
    ...(opts.mfaPaths ? { mfaProtectedPaths: opts.mfaPaths } : {}),
  });
  const protectedGet = (token: string, url = "/api/x") => drive(mw as never, { url, headers: { authorization: `Bearer ${token}` } });
  return { f, sign, realm, mw, store, protectedGet };
}

const cookie = (rt: string) => ({ cookie: `realmid_refresh=${rt}` });
const refreshReq = (rt: string, tenant: string, extra: Record<string, unknown> = {}) =>
  ({ url: "/token", method: "POST", headers: cookie(rt), body: { tenant_id: tenant, ...extra } });
const setCookieToken = (c: string[]) => c.map((x) => /realmid_refresh=([^;]*)/.exec(x)?.[1]).filter(Boolean).pop();

test("SPEC10_1_6a #64-67 revoked token: exact 401 body, never 412, handler not called; exempt not gated", async () => {
  const s = await setup({ mfaPaths: ["/api/*"] });
  const tok = await s.sign(claimsFor(NOW));
  assert.equal((await s.protectedGet(tok, "/other")).nextCalled, true);
  await s.realm.tokens.markRevoked(tok);
  const r = await s.protectedGet(tok, "/api/x");
  assert.equal(r.res.statusCode, 401);
  assert.equal(r.res.body, '{"error":{"code":"unauthorized","message":"access token revoked"},"revoked":true}');
  assert.equal(r.nextCalled, false);
  const exempt = await drive(s.mw as never, { url: "/health" });
  assert.equal(exempt.nextCalled, true);
});

test("SPEC10_1_3 #38-43 logout revokes the issuer-named session with no bearer; expired bearer revokes nothing", async () => {
  const s = await setup();
  s.f.logout = () => jsonRes(200, { status: "ok", sid: "s1" });
  const out = await drive(s.mw as never, { url: "/logout", method: "POST", headers: cookie("rt0") });
  assert.equal(out.res.statusCode, 200);
  assert.deepEqual(out.res.json, { status: "ok" });
  const other = await s.sign(claimsFor(NOW, { tenant_id: "globex", sub: "u-globex", jti: "j2" }));
  const r = await s.protectedGet(other);
  assert.equal(r.res.statusCode, 401);
  assert.equal(r.res.json["revoked"], true);

  const t = await setup();
  t.f.logout = () => jsonRes(200, { status: "ok" }); // v0.126.0 shape: no sid
  const expired = await t.sign(claimsFor(NOW - 5000, { exp: NOW - 4000 }));
  const o2 = await drive(t.mw as never, { url: "/logout", method: "POST", headers: { ...cookie("rt0"), authorization: `Bearer ${expired}` } });
  assert.equal(o2.res.statusCode, 200);
  assert.equal((await t.protectedGet(await t.sign(claimsFor(NOW)))).nextCalled, true, "expired bearer revoked nothing");
  const live = await t.sign(claimsFor(NOW));
  await drive(t.mw as never, { url: "/logout", method: "POST", headers: { ...cookie("rt0"), authorization: `Bearer ${live}` } });
  assert.equal((await t.protectedGet(live)).res.statusCode, 401, "valid unexpired bearer is the fallback");
  const bad = await setup();
  bad.f.logout = () => jsonRes(500, { error: { code: "server_error", message: "x" } });
  const o3 = await drive(bad.mw as never, { url: "/logout", method: "POST", headers: cookie("rt0") });
  assert.equal(o3.res.statusCode, 200, "logout never fails");
});

test("SPEC10_1_3 auth.logout: revoked_sids revokes every named session", async () => {
  const s = await setup();
  s.f.logout = () => jsonRes(200, { status: "ok", sid: "s1", revoked_sids: ["s1", "s2", "s3"] });
  await s.realm.auth.logout({ refreshToken: "rt0" });
  for (const sid of ["s1", "s2", "s3"]) {
    assert.equal((await s.protectedGet(await s.sign(claimsFor(NOW, { sid, jti: sid })))).res.statusCode, 401, sid);
  }
  assert.equal((await s.protectedGet(await s.sign(claimsFor(NOW, { sid: "s4", jti: "s4" })))).nextCalled, true);
});

function rotatingIssuer(s: Awaited<ReturnType<typeof setup>>, delayMs = 30) {
  const seen: string[] = [];
  let n = 0;
  s.f.token = async (body) => {
    const rt = String(body["refresh_token"]);
    seen.push(rt);
    await sleep(delayMs);
    n++;
    const tenant = String(body["tenant_id"]);
    const at = await s.sign(claimsFor(NOW + n, { tenant_id: tenant, sub: `u-${tenant}`, jti: `j${n}` }));
    return jsonRes(200, { access_token: at, refresh_token: `rt-${n}`, expires_in: 900, tenant_id: tenant, role: "member" });
  };
  return seen;
}

test("SPEC10_1_4a #45-46,57 concurrent same-cookie refreshes: ONE issuer call, identical outcome, org_session_mode", async () => {
  const s = await setup();
  const seen = rotatingIssuer(s);
  const rs = await Promise.all(Array.from({ length: 10 }, () => drive(s.mw as never, refreshReq("rt0", "acme"))));
  assert.equal(seen.length, 1);
  const first = rs[0]!.res;
  for (const r of rs) {
    assert.equal(r.res.statusCode, 200);
    assert.equal(r.res.json["access_token"], first.json["access_token"]);
    assert.equal(setCookieToken(r.res.setCookie), "rt-1");
    assert.equal(r.res.json["org_session_mode"], "concurrent");
  }
  assert.deepEqual(Object.keys(first.json).sort(), ["access_token", "expires_in", "org_session_mode", "role", "tenant_id"]);
});

test("SPEC10_1_4a #47 winner's error is shared; #48 different tenant gets 503 retry carrying the winner's token", async () => {
  const s = await setup();
  s.f.token = async () => { await sleep(30); return jsonRes(401, { error: { code: "unauthorized", message: "refresh_invalid" } }); };
  const [a, b] = await Promise.all([drive(s.mw as never, refreshReq("rt0", "acme")), drive(s.mw as never, refreshReq("rt0", "acme"))]);
  assert.equal(a.res.statusCode, 401);
  assert.equal(b.res.statusCode, 401);
  assert.equal(s.f.count("/auth/token"), 1);

  const t = await setup();
  const seen = rotatingIssuer(t);
  const [w, l] = await Promise.all([drive(t.mw as never, refreshReq("rt0", "acme")), drive(t.mw as never, refreshReq("rt0", "globex"))]);
  assert.equal(seen.length, 1);
  assert.equal(w.res.statusCode, 200);
  assert.equal(l.res.statusCode, 503);
  assert.deepEqual(l.res.json, { error: { code: "server_error", message: "refresh superseded, retry" }, retry: true });
  assert.equal(setCookieToken(l.res.setCookie), setCookieToken(w.res.setCookie), "same token either order");
  const retry = await drive(t.mw as never, refreshReq("rt-1", "globex"));
  assert.equal(retry.res.statusCode, 200);
  assert.equal(seen[1], "rt-1", "retry uses the NEW token, never the old one");
  assert.equal(retry.res.json["tenant_id"], "globex");
});

test("SPEC10_1_4a body mode: loser's 503 carries refresh_token; MFA/no-candidate and store error", async () => {
  const s = await setup({ tokenDelivery: "body" });
  rotatingIssuer(s);
  const rq = (tenant: string) => ({ url: "/token", method: "POST", headers: {}, body: { refresh_token: "rt0", tenant_id: tenant } });
  const [w, l] = await Promise.all([drive(s.mw as never, rq("acme")), drive(s.mw as never, rq("globex"))]);
  assert.equal(w.res.json["refresh_token"], "rt-1");
  assert.equal(l.res.statusCode, 503);
  assert.equal(l.res.json["refresh_token"], "rt-1");

  const inner = createMemorySessionStore({ now: () => NOW * 1000 });
  const failing = await setup({ store: { ...inner, acquireRefreshLock: async () => { throw new Error("down"); } } });
  rotatingIssuer(failing);
  const r = await drive(failing.mw as never, refreshReq("rt0", "acme"));
  assert.equal(r.res.statusCode, 503);
  assert.equal((r.res.json["error"] as Record<string, unknown>)["message"], "session store unavailable");
  assert.equal(failing.f.count("/auth/token"), 0);
});

test("SPEC10_1_4b #59-61a,63 a rotating refresh refuses older tokens (per mode); non-rotating records nothing", async () => {
  for (const mode of ["concurrent", "exclusive"] as const) {
    const s = await setup();
    s.f.discovery = { status: 200, body: { realmid_org_sessions: mode } };
    const acme = await s.sign(claimsFor(NOW - 100, { jti: "old" }));
    rotatingIssuer(s, 1);
    const r = await drive(s.mw as never, refreshReq("rt0", "globex"));
    assert.equal(r.res.json["org_session_mode"], mode);
    const stale = await s.protectedGet(acme);
    assert.equal(stale.res.statusCode, mode === "exclusive" ? 401 : 200, `acme token in ${mode}`);
    const oldGlobex = await s.sign(claimsFor(NOW - 100, { tenant_id: "globex", sub: "u-globex", jti: "og" }));
    const og = await s.protectedGet(oldGlobex);
    assert.equal(og.res.statusCode, 401);
    assert.equal(og.res.json["revoked"], true);
    assert.equal((await s.protectedGet(String(r.res.json["access_token"]))).nextCalled, true);
  }
  const n = await setup();
  n.f.token = async (body) => jsonRes(200, {
    access_token: await n.sign(claimsFor(NOW + 5, { tenant_id: "acme" })), refresh_token: String(body["refresh_token"]), expires_in: 900, tenant_id: "acme", role: "m",
  });
  const prev = await n.sign(claimsFor(NOW - 100));
  await drive(n.mw as never, refreshReq("rt-same", "acme"));
  assert.equal((await n.protectedGet(prev)).nextCalled, true, "non-rotating refresh must not supersede");
});

test("SPEC10_1_5 #98 MFA verify with no refresh cookie takes no lock; with one it spends the token once", async () => {
  const inner = createMemorySessionStore({ now: () => NOW * 1000 });
  const locks: string[] = [];
  const s = await setup({ store: { ...inner, acquireRefreshLock: async (k, t) => { locks.push(k); return inner.acquireRefreshLock(k, t); } } });
  s.f.mfaVerify = async () => jsonRes(200, {
    access_token: await s.sign(claimsFor(NOW)), refresh_token: "rt-mfa", expires_in: 900, user: { id: "u" }, tenants: [], tenant_id: "acme", role: "m",
  });
  const first = await drive(s.mw as never, { url: "/mfa/verify", method: "POST", headers: {}, body: { challenge_token: "c", code: "1" } });
  assert.equal(first.res.statusCode, 200);
  assert.equal(first.res.json["org_session_mode"], "concurrent");
  assert.deepEqual(locks, []);
  const second = await drive(s.mw as never, { url: "/mfa/verify", method: "POST", headers: cookie("rt0"), body: { challenge_token: "c", code: "1" } });
  assert.equal(second.res.statusCode, 200);
  assert.equal(locks.length, 1);
  assert.match(locks[0]!, /^realmid:v1:lock\|[0-9a-f]{64}$/);
  assert.ok(!locks[0]!.includes("rt0"));
  // a refresh racing it within the window is handed the MFA verify's rotated token
  const r = await drive(s.mw as never, refreshReq("rt0", "acme"));
  assert.equal(r.res.statusCode, 503);
  assert.equal(setCookieToken(r.res.setCookie), "rt-mfa");
});
