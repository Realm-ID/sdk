/**
 * Critic-review fixes for 0.55.0 (go parity): login mint unwrap, stored issuer
 * status, bounded lock-path store calls, jti revocation, `**` segment boundary.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { createMemorySessionStore, type SessionStateStore } from "./session-store.js";
import { RealmError } from "./errors.js";
import { globMatch } from "./middleware.js";
import { MemRevocationCache } from "./revocation.js";
import { AUD, BASE, REALM, claimsFor, drive, fakeIssuer, jsonRes, makeSigner } from "./v063-fixture.test.js";

const NOW = 1_800_000_000;
const cookie = (rt: string) => ({ cookie: `realmid_refresh=${rt}` });

async function setup(store?: SessionStateStore, extra: Record<string, unknown> = {}) {
  const { publicJwk, sign } = await makeSigner();
  const f = fakeIssuer(publicJwk);
  const st = store ?? createMemorySessionStore({ now: () => Date.now() });
  const realm = createRealm({
    realmId: REALM, apiKey: "rk_live_x", baseUrl: BASE, origin: "https://app.test", audience: AUD,
    fetch: f.fetch, clock: () => new Date(NOW * 1000), sessionStore: st, ...extra,
  });
  return { f, sign, realm, st, mw: realm.middleware({ exemptPaths: ["/health"] }) };
}

// ---- 2. handleLogin unwraps LoginMintError ----

async function loginWithMint(status: number, code: string) {
  const s = await setup(undefined, { productRoles: async () => [] });
  s.f.login = async () => jsonRes(200, {
    access_token: await s.sign(claimsFor(NOW)), refresh_token: "rt-1", expires_in: 900,
    user: { id: "u" }, tenants: [{ id: "acme", tenant_id: "acme", role: "m" }], tenant_id: "acme", role: "m",
  });
  s.f.token = () => jsonRes(status, { error: { code, message: "refused by issuer" } });
  return drive(s.mw as never, { url: "/login", method: "POST", body: { method: "firebase", provider_token: "p" } });
}

test("TestLogin_MintRefusalIsRelayedNotServerError: user_suspended 403", async () => {
  const { res } = await loginWithMint(403, "user_suspended");
  assert.equal(res.statusCode, 403);
  assert.equal((res.json["error"] as { code: string }).code, "user_suspended");
});

test("TestLogin_MintRefusalIsRelayedNotServerError: tenant_disabled 403", async () => {
  const { res } = await loginWithMint(403, "tenant_disabled");
  assert.equal(res.statusCode, 403);
  assert.equal((res.json["error"] as { code: string }).code, "tenant_disabled");
});

test("TestLogin_MintRefusalIsRelayedNotServerError: escort_suspended 403 is relayed as 503", async () => {
  const { res } = await loginWithMint(403, "escort_suspended");
  assert.equal(res.statusCode, 503);
  assert.equal((res.json["error"] as { code: string }).code, "escort_suspended");
});

test("TestLogin_MintMfaRequiredTakesTheMfaBranch", async () => {
  const s = await setup(undefined, { productRoles: async () => [] });
  s.f.login = async () => jsonRes(200, {
    access_token: await s.sign(claimsFor(NOW)), refresh_token: "rt-1", expires_in: 900,
    user: { id: "u" }, tenants: [{ id: "acme", tenant_id: "acme", role: "m" }], tenant_id: "acme", role: "m",
  });
  s.f.token = () => jsonRes(412, { error: { code: "mfa_required", message: "mfa" }, mfa_challenge_token: "ch1", methods: ["totp"] });
  const { res } = await drive(s.mw as never, { url: "/login", method: "POST", body: { method: "firebase", provider_token: "p" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json["status"], "mfa_required");
  assert.equal(res.json["mfa_challenge_token"], "ch1");
});

test("TestLogin_HookErrorInsideMintIsNotLeaked", async () => {
  const s = await setup(undefined, { productRoles: async () => { throw new Error("secret partner db password"); } });
  s.f.login = async () => jsonRes(200, {
    access_token: await s.sign(claimsFor(NOW)), refresh_token: "rt-1", expires_in: 900,
    user: { id: "u" }, tenants: [{ id: "acme", tenant_id: "acme", role: "m" }], tenant_id: "acme", role: "m",
  });
  const { res } = await drive(s.mw as never, { url: "/login", method: "POST", body: { method: "firebase", provider_token: "p" } });
  assert.equal(res.statusCode, 500);
  assert.ok(!res.body.includes("secret partner db password"), res.body);
});

// ---- 3. stored status is the issuer's; relay remaps only on the wire ----

test("TestToken_EscortSuspendedDirectKeepsIssuerStatusAndCause; middleware relays 503", async () => {
  const s = await setup();
  s.f.token = () => jsonRes(403, { error: { code: "escort_suspended", message: "escort off" } });
  await assert.rejects(
    s.realm.auth.token({ refreshToken: "rt-e", tenantId: "acme" }),
    (e: RealmError) => e.code === "escort_suspended" && e.httpStatus === 403,
  );
  const s2 = await setup();
  s2.f.token = () => jsonRes(403, { error: { code: "escort_suspended", message: "escort off" } });
  const { res } = await drive(s2.mw as never, { url: "/token", method: "POST", headers: cookie("rt-e2"), body: { tenant_id: "acme" } });
  assert.equal(res.statusCode, 503);
  assert.equal((res.json["error"] as { code: string }).code, "escort_suspended");
});

test("TestToken_DirectErrorKeepsCause", async () => {
  const s = await setup();
  s.f.token = () => jsonRes(403, { error: { code: "forbidden", message: "no" } });
  const probe = new Error("root cause");
  const orig = s.f.fetch;
  s.f.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    if (String(i).endsWith("/auth/token")) throw probe;
    return orig(i, init);
  }) as typeof fetch;
  const realm2 = createRealm({
    realmId: REALM, apiKey: "rk_live_x", baseUrl: BASE, origin: "https://app.test", audience: AUD,
    fetch: s.f.fetch, clock: () => new Date(NOW * 1000), sessionStore: createMemorySessionStore(),
  });
  const e = (await realm2.auth.token({ refreshToken: "rt-c", tenantId: "acme" }).catch((x) => x)) as RealmError;
  assert.ok(e instanceof RealmError);
  assert.ok(e.cause !== undefined, "the winner's thrown error keeps its cause");
});

// ---- 4. the lock path's store calls are time-bounded ----

const hang = () => new Promise<never>(() => undefined);

test("TestLockPath_OutcomeReadHangFailsClosedWith503 (bounded at 2s)", async () => {
  const inner = createMemorySessionStore({ now: () => Date.now() });
  const s = await setup({ ...inner, getRefreshResult: hang });
  const t0 = Date.now();
  await assert.rejects(
    s.realm.auth.token({ refreshToken: "rt-h", tenantId: "acme" }),
    (e: RealmError) => e.httpStatus === 503,
  );
  assert.ok(Date.now() - t0 < 4000, "bounded, not hung");
  assert.equal(s.f.count("/auth/token"), 0, "never minted on an unreadable outcome");
});

test("TestLockPath_OutcomeWriteAndReleaseHangAreLoggedAndContinue", async () => {
  const inner = createMemorySessionStore({ now: () => Date.now() });
  const s = await setup({
    ...inner,
    putRefreshResult: hang,
    acquireRefreshLock: async (k, t) => {
      const l = await inner.acquireRefreshLock(k, t);
      return { acquired: l.acquired, release: hang };
    },
  });
  s.f.token = async () => jsonRes(200, {
    access_token: await s.sign(claimsFor(NOW)), refresh_token: "rt-n", expires_in: 900, tenant_id: "acme", role: "m",
  });
  const t0 = Date.now();
  const r = await s.realm.auth.token({ refreshToken: "rt-w", tenantId: "acme" });
  assert.equal(r.refreshToken, "rt-n");
  assert.ok(Date.now() - t0 < 6000, "write and release each bounded");
});

// ---- 5. verifier checks jti as well as the session key ----

test("TestVerify_RevocationChecksJtiWhenItDiffersFromSid", async () => {
  const cache = new MemRevocationCache();
  const s = await setup(undefined, { revocation: cache });
  const tok = await s.sign(claimsFor(NOW, { sid: "sess-1", jti: "jti-1" }));
  await s.realm.verify(tok);
  await cache.revoke("jti-1", Date.now() + 60_000);
  await assert.rejects(s.realm.verify(tok), (e: RealmError) => /revoked/.test(e.message));
});

// ---- 6. `**` keeps the segment boundary ----

const GLOB: [string, string, boolean][] = [
  ["/a/**/b", "/a/b", true], ["/a/**/b", "/a/x/b", true], ["/a/**/b", "/a/x/y/b", true],
  ["/a/**/b", "/ab", false], ["/a/**/b", "/a/xb", false], ["/a/**/b", "/axb", false],
  ["/x/**", "/x", true], ["/x/**", "/x/", true], ["/x/**", "/x/y", true], ["/x/**", "/xy", false],
  ["/**", "/", true], ["/**", "/anything/at/all", true], ["/**", "/a", true],
  ["/public/**/assets", "/publicassets", false], ["/public/**/assets", "/public/evilassets", false],
  ["/public/**/assets", "/public/assets", true],
];
for (const [pat, path, want] of GLOB) {
  test(`TestGlob: ${pat} vs ${path} = ${want}`, () => {
    assert.equal(globMatch(pat, path), want);
    assert.equal(globMatch(pat, path, { braces: true }), want);
  });
}
