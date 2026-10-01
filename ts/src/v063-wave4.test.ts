import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { createMemorySessionStore, lockKey, type SessionStateStore } from "./session-store.js";
import { MemRevocationCache } from "./revocation.js";
import { AUD, BASE, REALM, claimsFor, drive, fakeIssuer, jsonRes, makeSigner } from "./v063-fixture.test.js";

const NOW = 1_800_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(opts: { store?: SessionStateStore; revocation?: MemRevocationCache } = {}) {
  const { publicJwk, sign } = await makeSigner();
  const f = fakeIssuer(publicJwk);
  const store = opts.store ?? createMemorySessionStore({ now: () => Date.now() });
  const realm = createRealm({
    realmId: REALM, apiKey: "rk_live_x", baseUrl: BASE, origin: "https://app.test", audience: AUD,
    fetch: f.fetch, clock: () => new Date(NOW * 1000), sessionStore: store,
    ...(opts.revocation ? { revocation: opts.revocation } : {}),
  });
  const mw = realm.middleware({ exemptPaths: ["/health"] });
  const get = (token: string) => drive(mw as never, { url: "/api/x", headers: { authorization: `Bearer ${token}` } });
  return { f, sign, realm, mw, store, get };
}
const cookie = (...rts: string[]) => ({ cookie: rts.map((r) => `realmid_refresh=${r}`).join("; ") });

test("OWNER 2cb2f23 logout all: auth.logout({all:true}) sends all:true; omitted otherwise; every revoked_sids is revoked", async () => {
  const s = await setup();
  s.f.logout = () => jsonRes(200, { status: "ok", sid: "s1", revoked_sids: ["s1", "s2"] });
  await s.realm.auth.logout({ refreshToken: "rt0", all: true });
  const body = s.f.calls.find((c) => c.url.endsWith("/auth/logout"))!.body;
  assert.equal(body["all"], true);
  assert.equal(body["refresh_token"], "rt0");
  for (const sid of ["s1", "s2"]) {
    assert.equal((await s.get(await s.sign(claimsFor(NOW, { sid, jti: sid })))).res.statusCode, 401, sid);
  }
  const t = await setup();
  await t.realm.auth.logout({ refreshToken: "rt0" });
  assert.ok(!("all" in t.f.calls.find((c) => c.url.endsWith("/auth/logout"))!.body), "all is absent unless asked");
});

test("SPEC10_1_3a L2: zero cookies -> no issuer call; a live verified bearer is the fallback, an expired one revokes nothing", async () => {
  const s = await setup();
  const live = await s.sign(claimsFor(NOW));
  const r = await drive(s.mw as never, { url: "/logout", method: "POST", headers: { authorization: `Bearer ${live}` } });
  assert.equal(r.res.statusCode, 200);
  assert.equal(s.f.count("/auth/logout"), 0, "no refresh token -> the issuer is not called");
  assert.equal((await s.get(live)).res.statusCode, 401, "no-cookie bearer fallback revoked the session");

  const t = await setup();
  const expired = await t.sign(claimsFor(NOW - 5000, { exp: NOW - 4000 }));
  await drive(t.mw as never, { url: "/logout", method: "POST", headers: { authorization: `Bearer ${expired}` } });
  assert.equal(t.f.count("/auth/logout"), 0);
  assert.equal((await t.get(await t.sign(claimsFor(NOW)))).nextCalled, true, "expired bearer revoked nothing");
});

test("SPEC10_1_3a #M2 revoking EVERY cookie candidate: the last candidate's session dies, not only the first", async () => {
  const s = await setup();
  s.f.logout = (b) => jsonRes(200, { status: "ok", sid: `s-${b["refresh_token"]}` });
  await drive(s.mw as never, { url: "/logout", method: "POST", headers: cookie("a", "b", "c") });
  assert.equal(s.f.count("/auth/logout"), 3);
  for (const sid of ["s-a", "s-b", "s-c"]) {
    assert.equal((await s.get(await s.sign(claimsFor(NOW, { sid, jti: sid })))).res.statusCode, 401, sid);
  }
});

test("SPEC10_1_3a #M2 Config.Revocation push: auth.logout writes the named sid (and the bearer fallback's key) to the shared cache", async () => {
  const rev = new MemRevocationCache(() => NOW * 1000);
  const s = await setup({ revocation: rev });
  s.f.logout = () => jsonRes(200, { status: "ok", sid: "sx", revoked_sids: ["sx", "sy"] });
  await s.realm.auth.logout({ refreshToken: "rt0" });
  assert.equal(await rev.isRevoked("sx"), true);
  assert.equal(await rev.isRevoked("sy"), true);
  assert.equal(await rev.isRevoked("sz"), false);

  const rev2 = new MemRevocationCache(() => NOW * 1000);
  const t = await setup({ revocation: rev2 });
  const live = await t.sign(claimsFor(NOW, { sid: "sb", jti: "jb" }));
  await drive(t.mw as never, { url: "/logout", method: "POST", headers: { authorization: `Bearer ${live}` } });
  assert.equal(await rev2.isRevoked("sb"), true, "bearer fallback pushes to the cache too");
});

test("SPEC10_1_4a #M1 the lock outlives a full-length mint: TTL 15 s, not the 10 s mint bound", async () => {
  let ttl = 0;
  const base = createMemorySessionStore({ now: () => Date.now() });
  const store: SessionStateStore = { ...base, acquireRefreshLock: (k, t) => { ttl = t; return base.acquireRefreshLock(k, t); } };
  const s = await setup({ store });
  s.f.token = async () => jsonRes(200, { access_token: await s.sign(claimsFor(NOW + 1)), refresh_token: "rt-1", expires_in: 900, tenant_id: "acme", role: "m" });
  await drive(s.mw as never, { url: "/token", method: "POST", headers: cookie("rt0"), body: { tenant_id: "acme" } });
  assert.equal(ttl, 15_000);
});

test("SPEC10_1_4a #M1 outcome is stored under a FRESH context: a store that rejects after the mint bound still receives the 504 outcome", { timeout: 25_000 }, async () => {
  const base = createMemorySessionStore({ now: () => Date.now() });
  const stored: string[] = [];
  const store: SessionStateStore = { ...base, putRefreshResult: async (k, v, t) => { stored.push(v); return base.putRefreshResult(k, v, t); } };
  const s = await setup({ store });
  s.f.token = () => new Promise<Response>(() => {});
  const r = await drive(s.mw as never, { url: "/token", method: "POST", headers: cookie("rt0"), body: { tenant_id: "acme" } });
  assert.equal(r.res.statusCode, 504);
  assert.equal(stored.length, 1, "error outcome stored");
  assert.equal(JSON.parse(stored[0]!).ok, false);
  const again = await s.store.acquireRefreshLock(await lockKey("rt0"), 1000);
  assert.equal(again.acquired, true);
  await again.release();
});

test("SPEC10_1_4a #M1 a late rotation after the bound is not lost: the stored 504 outcome is replaced by the real one", { timeout: 25_000 }, async () => {
  const s = await setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  s.f.token = async () => {
    await gate;
    return jsonRes(200, { access_token: await s.sign(claimsFor(NOW + 1)), refresh_token: "rt-late", expires_in: 900, tenant_id: "acme", role: "m" });
  };
  const r = await drive(s.mw as never, { url: "/token", method: "POST", headers: cookie("rt0"), body: { tenant_id: "acme" } });
  assert.equal(r.res.statusCode, 504);
  release();
  await sleep(100);
  const retry = await drive(s.mw as never, { url: "/token", method: "POST", headers: cookie("rt0"), body: { tenant_id: "acme" } });
  assert.equal(retry.res.statusCode, 200, "the rotation the issuer performed is handed to the retry");
  assert.match(retry.res.setCookie.join(";"), /realmid_refresh=rt-late/);
  assert.equal(s.f.count("/auth/token"), 1, "the spent token is never re-presented");
});

test("SPEC10_2 L1: when every candidate fails the FIRST failure is reported (Go/Java parity)", async () => {
  const s = await setup();
  s.f.token = async (b) => jsonRes(401, { error: { code: "unauthorized", message: `bad-${b["refresh_token"]}` } });
  const r = await drive(s.mw as never, { url: "/token", method: "POST", headers: cookie("a", "b"), body: { tenant_id: "acme" } });
  assert.equal(r.res.statusCode, 401);
  assert.equal((r.res.json["error"] as Record<string, unknown>)["message"], "bad-a");
});

test("L5 error envelope: a details key named `error` never clobbers the envelope", async () => {
  const s = await setup();
  s.f.token = async () => jsonRes(403, { code: "forbidden", message: "nope", error: 5, extra: 1 }) /* shape 3: `error` survives into details */;
  const r = await drive(s.mw as never, { url: "/token", method: "POST", headers: cookie("a"), body: { tenant_id: "acme" } });
  assert.equal((r.res.json["error"] as Record<string, unknown>)["code"], "forbidden");
  assert.equal(r.res.json["extra"], 1, "other details keys still merge");
});

test("SPEC10_1_4a #M2 reload-path fingerprint check: a stored outcome for another fingerprint is NOT served to a winner", async () => {
  const s = await setup();
  let n = 0;
  s.f.token = async (b) => {
    n++;
    return jsonRes(200, { access_token: await s.sign(claimsFor(NOW + n)), refresh_token: `rt-${n}`, expires_in: 900, tenant_id: String(b["tenant_id"]), role: "m" });
  };
  const a = await drive(s.mw as never, { url: "/token", method: "POST", headers: cookie("rt0"), body: { tenant_id: "acme" } });
  assert.equal(a.res.statusCode, 200);
  // Same cookie, other tenant, inside the 5 s window: the outcome is for "acme".
  const b = await drive(s.mw as never, { url: "/token", method: "POST", headers: cookie("rt0"), body: { tenant_id: "globex" } });
  assert.equal(s.f.count("/auth/token"), 1, "the spent token is not re-presented to the issuer");
  assert.equal(b.res.statusCode, 503, "a different fingerprint gets the retry hand-over, never the other tenant's mint");
  assert.equal(b.res.json["retry"], true);
  assert.equal(b.res.json["access_token"], undefined);
});
