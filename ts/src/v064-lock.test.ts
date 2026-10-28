/**
 * go 0.64.0-0.64.2 parity (SPEC §4.2, §4.3, §4.3a, §10.1 steps 4a/5/5a, §6.7.2):
 * recovery-code redeem, the optional per-session lock on direct MFA calls,
 * `auth.token` under the same lock, outcome-read errors that never re-mint, the
 * in-memory sweep, the typed superseded give-up and bounded store reads.
 * Test names mirror go/{mfa_recovery_redeem,direct_mfa_lock*,token_lock*,tokens_cancel}_test.go.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { inspect } from "node:util";
import { createRealm } from "./realm.js";
import { createMemorySessionStore, lockKey, outKey, type SessionStateStore } from "./session-store.js";
import { RefreshSupersededError, RealmError } from "./errors.js";
import { AUD, BASE, REALM, claimsFor, drive, fakeIssuer, jsonRes, makeSigner, refreshCount } from "./v063-fixture.test.js";
import type { IdentityResolvedEvent } from "./identity-resolved.js";

const NOW = 1_800_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cookie = (rt: string) => ({ cookie: `realmid_refresh=${rt}` });
const lastCookie = (c: string[]) => c.map((x) => /realmid_refresh=([^;]*)/.exec(x)?.[1]).filter(Boolean).pop();
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("condition not reached");
    await sleep(5);
  }
}
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => { open = r; });
  return { wait, open };
}

interface SetupOpts {
  store?: SessionStateStore;
  mw?: Record<string, unknown>;
  hook?: (ev: IdentityResolvedEvent) => void;
  productRoles?: () => Promise<string[]>;
}

async function setup(opts: SetupOpts = {}) {
  const { publicJwk, sign } = await makeSigner();
  const f = fakeIssuer(publicJwk);
  const store = opts.store ?? createMemorySessionStore({ now: () => Date.now() });
  const realm = createRealm({
    realmId: REALM, apiKey: "rk_live_x", baseUrl: BASE, origin: "https://app.test", audience: AUD,
    fetch: f.fetch, clock: () => new Date(NOW * 1000), sessionStore: store,
    ...(opts.hook ? { onIdentityResolved: opts.hook } : {}),
    ...(opts.productRoles ? { productRoles: opts.productRoles } : {}),
  });
  const mw = realm.middleware({ exemptPaths: ["/health"], ...(opts.mw ?? {}) });
  let mints = 0;
  const seen: string[] = [];
  const tokenGate: { g?: ReturnType<typeof gate> } = {};
  f.token = async (body) => {
    seen.push(String(body["refresh_token"]));
    if (tokenGate.g) await tokenGate.g.wait;
    mints++;
    return jsonRes(200, {
      access_token: await sign(claimsFor(NOW + mints)), refresh_token: `rt-new-${mints}`,
      expires_in: 900, tenant_id: String(body["tenant_id"] ?? "acme"), role: "m",
    });
  };
  const mfaGate: { g?: ReturnType<typeof gate> } = {};
  const sessionBody = async (rt: string) => jsonRes(200, {
    access_token: await sign(claimsFor(NOW)), refresh_token: rt, expires_in: 900,
    user: { id: "u" }, tenants: [{ tenant_id: "acme", role: "m" }], tenant_id: "acme", role: "m",
  });
  f.mfaVerify = async () => { if (mfaGate.g) await mfaGate.g.wait; return sessionBody("rt-mfa-1"); };
  f.recovery = async () => {
    if (mfaGate.g) await mfaGate.g.wait;
    const r = await sessionBody("rt-rec-1");
    return jsonRes(200, { ...((await r.json()) as object), reenroll_required: true });
  };
  return { f, sign, realm, mw, store, seen, tokenGate, mfaGate, issuerMints: () => seen.length };
}
type S = Awaited<ReturnType<typeof setup>>;
const refreshReq = (rt: string, extra: Record<string, unknown> = {}) =>
  ({ url: "/token", method: "POST", headers: cookie(rt), body: { tenant_id: "acme", ...extra } });

/** A store whose own methods can be intercepted. */
function wrapStore(inner: SessionStateStore, over: Partial<SessionStateStore>): SessionStateStore {
  return { ...inner, ...over };
}

// ---------------------------------------------------------------- §4.3a redeem

test("TestRedeemRecoveryCode_RequestAndResponse: wire body, reenrollRequired, refreshToken never sent", async () => {
  const s = await setup();
  const r = await s.realm.auth.redeemRecoveryCode({ challengeToken: "ch", code: "abcd-efgh", refreshToken: "rt-old" });
  const body = s.f.calls.find((c) => c.url.endsWith("/auth/mfa/recovery"))!.body;
  assert.deepEqual(Object.keys(body).sort(), ["code", "mfa_challenge_token", "realm_id"]);
  assert.equal(body["mfa_challenge_token"], "ch");
  assert.equal(body["code"], "abcd-efgh");
  // R51: the verify/recovery answer is minted through /auth/token, which rotates the token again.
  assert.equal(r.refreshToken, "rt-new-1");
  assert.equal(r.reenrollRequired, true, "a successful redeem tells the caller to re-enroll");
});

test("TestRedeemRecoveryCode_RequestAndResponse: reenroll_required on the wire wins; absent stays undefined on mfaVerify", async () => {
  const s = await setup();
  const old = s.f.recovery;
  s.f.recovery = async (b) => {
    const res = await old(b);
    const j = (await res.json()) as Record<string, unknown>;
    return jsonRes(200, { ...j, reenroll_required: false });
  };
  assert.equal((await s.realm.auth.redeemRecoveryCode({ challengeToken: "c", code: "x" })).reenrollRequired, false);
  const v = await s.realm.auth.mfaVerify({ challengeToken: "c", code: "1" });
  assert.equal(v.reenrollRequired, undefined);
});

test("TestRedeemRecoveryCode_RunsProductRolesMint: ADR-102 D10 mint under flow mfa_recovery", async () => {
  const seen: IdentityResolvedEvent[] = [];
  const s = await setup({ hook: (ev) => { seen.push(ev); } });
  await s.realm.auth.redeemRecoveryCode({ challengeToken: "c", code: "x" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.flow, "mfa_recovery");
});

test("TestRedeemRecoveryCode_ErrorMapping: 401 and 429 surface as RealmError", async () => {
  const s = await setup();
  s.f.recovery = () => jsonRes(401, { error: { code: "unauthorized", message: "bad code" } });
  await assert.rejects(s.realm.auth.redeemRecoveryCode({ challengeToken: "c", code: "x" }), (e: RealmError) => e.code === "unauthorized" && e.httpStatus === 401);
  s.f.recovery = () => jsonRes(429, { error: { code: "rate_limited", message: "slow down", details: { server_code: "mfa_too_many_fails" } } });
  await assert.rejects(s.realm.auth.redeemRecoveryCode({ challengeToken: "c", code: "x" }), (e: RealmError) => e.code === "rate_limited" && e.httpStatus === 429);
});

test("TestAuthFlowMFARecoveryIsDistinct: mfaVerify fires mfa_verify, redeem fires mfa_recovery", async () => {
  const seen: string[] = [];
  const s = await setup({ hook: (ev) => { seen.push(ev.flow); } });
  await s.realm.auth.mfaVerify({ challengeToken: "c", code: "1" });
  await s.realm.auth.redeemRecoveryCode({ challengeToken: "c", code: "x" });
  assert.deepEqual(seen, ["mfa_verify", "mfa_recovery"]);
});

// ------------------------------------------------------- middleware recovery route

const recBody = { challenge_token: "c", code: "abcd-efgh" };

test("TestMiddlewareRecovery_TakesTheRefreshLockAndStoresOutcome + BodyCarriesReenrollRequired", async () => {
  const locks: string[] = [];
  const inner = createMemorySessionStore({ now: () => Date.now() });
  const s = await setup({
    store: wrapStore(inner, { acquireRefreshLock: async (k, t) => { locks.push(k); return inner.acquireRefreshLock(k, t); } }),
    mw: { recoveryPath: "/mfa/recovery" },
  });
  const r = await drive(s.mw as never, { url: "/mfa/recovery", method: "POST", headers: cookie("rt0"), body: recBody });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.res.json["reenroll_required"], true);
  assert.equal(r.res.json["org_session_mode"], "concurrent");
  assert.equal(lastCookie(r.res.setCookie), "rt-new-1");
  assert.deepEqual(locks, [await lockKey("rt0")], "exactly one acquire, keyed on the cookie's token");
  const stored = JSON.parse((await inner.getRefreshResult(await outKey("rt0")))!);
  assert.equal(stored.fp, "mfa-verify", "same outcome fingerprint as the verify route");
  assert.equal(stored.refreshToken, "rt-new-1");
  // a refresh racing it is handed the rotated token, never re-presenting the spent one
  const rr = await drive(s.mw as never, refreshReq("rt0"));
  assert.equal(rr.res.statusCode, 503);
  assert.equal(lastCookie(rr.res.setCookie), "rt-new-1");
  assert.equal(s.issuerMints(), 1, "only the recovery's own /auth/token mint (R51); the racing refresh minted nothing");
  assert.ok(!s.seen.includes("rt0"), "the spent cookie token was never re-presented");
});

test("TestMiddlewareRecovery_UnsetPathServesNothing: opt-in, no default", async () => {
  const s = await setup();
  const r = await drive(s.mw as never, { url: "/mfa/recovery", method: "POST", headers: cookie("rt0"), body: recBody });
  assert.equal(r.res.statusCode, 401, "falls through to the bearer check");
  assert.equal(s.f.count("/auth/mfa/recovery"), 0);
});

test("TestMiddlewareRecovery_PathCanBeRenamed", async () => {
  const s = await setup({ mw: { recoveryPath: "/r/redeem" } });
  assert.equal((await drive(s.mw as never, { url: "/r/redeem", method: "POST", headers: cookie("rt0"), body: recBody })).res.statusCode, 200);
  assert.equal((await drive(s.mw as never, { url: "/mfa/recovery", method: "POST", headers: cookie("rt0"), body: recBody })).res.statusCode, 401);
});

test("TestMiddlewareRecovery: first-login (no cookie) takes no lock; mfa_challenge_token also accepted", async () => {
  let acquires = 0;
  const inner = createMemorySessionStore();
  const s = await setup({
    store: wrapStore(inner, { acquireRefreshLock: async (k, t) => { acquires++; return inner.acquireRefreshLock(k, t); } }),
    mw: { recoveryPath: "/mfa/recovery" },
  });
  const r = await drive(s.mw as never, { url: "/mfa/recovery", method: "POST", headers: {}, body: { mfa_challenge_token: "c", code: "x" } });
  assert.equal(r.res.statusCode, 200);
  assert.equal(acquires, 0);
  assert.equal(s.f.calls.find((c) => c.url.endsWith("/auth/mfa/recovery"))!.body["mfa_challenge_token"], "c");
});

test("TestMiddlewareRecovery_WaitingTooLongIs503AndIssuerNotCalled", { timeout: 10_000 }, async () => {
  const inner = createMemorySessionStore({ now: () => Date.now() });
  const s = await setup({ store: inner, mw: { recoveryPath: "/mfa/recovery" } });
  await inner.acquireRefreshLock(await lockKey("rt0"), 60_000); // held by someone else
  const r = await drive(s.mw as never, { url: "/mfa/recovery", method: "POST", headers: cookie("rt0"), body: recBody });
  assert.equal(r.res.statusCode, 503);
  assert.equal(r.res.json["error"] && (r.res.json["error"] as Record<string, unknown>)["message"], "refresh in progress");
  assert.equal(s.f.count("/auth/mfa/recovery"), 0);
});

// ------------------------------------------------------------ direct MFA lock

interface Direct { name: string; call: (s: S, rt?: string) => Promise<unknown>; path: string; rotated: string; minted: string }
const directs: Direct[] = [
  { name: "mfaVerify", path: "/auth/mfa/verify", rotated: "rt-mfa-1", minted: "rt-new-1",
    call: (s, rt) => s.realm.auth.mfaVerify({ challengeToken: "c", code: "1", refreshToken: rt }) },
  { name: "mfaVerifyOtp", path: "/auth/mfa/verify", rotated: "rt-mfa-1", minted: "rt-new-1",
    call: (s, rt) => s.realm.auth.mfaVerifyOtp({ mfaToken: "c", presented: "1", refreshToken: rt }) },
  { name: "redeemRecoveryCode", path: "/auth/mfa/recovery", rotated: "rt-rec-1", minted: "rt-new-1",
    call: (s, rt) => s.realm.auth.redeemRecoveryCode({ challengeToken: "c", code: "abcd-efgh", refreshToken: rt }) },
];

for (const d of directs) {
  test(`TestDirectMFA_StoresOutcomeAndReleasesLock [${d.name}]: never on the wire, outcome under the key, lock freed`, async () => {
    const inner = createMemorySessionStore({ now: () => Date.now() });
    const s = await setup({ store: inner });
    await d.call(s, "rt-old");
    const call = s.f.calls.find((c) => c.url.endsWith(d.path))!;
    assert.ok(!JSON.stringify(call.body).includes("rt-old"), "the refresh token is never sent on the wire");
    const stored = JSON.parse((await inner.getRefreshResult(await outKey("rt-old")))!);
    assert.equal(stored.fp, "mfa-verify");
    assert.equal(stored.refreshToken, d.minted);
    assert.equal((await inner.acquireRefreshLock(await lockKey("rt-old"), 1000)).acquired, true, "lock released");
  });

  test(`TestDirectMFA_EmptyRefreshTokenTakesNoLock [${d.name}]`, async () => {
    let acquires = 0;
    const inner = createMemorySessionStore();
    const s = await setup({ store: wrapStore(inner, { acquireRefreshLock: async (k, t) => { acquires++; return inner.acquireRefreshLock(k, t); } }) });
    await d.call(s);
    assert.equal(acquires, 0);
    assert.equal(await inner.getRefreshResult(await outKey("")), undefined);
  });

  test(`TestDirectMFA_RefreshLockSerializesAgainstMiddlewareRefresh [${d.name}]`, async () => {
    const s = await setup({ mw: { recoveryPath: "/mfa/recovery" } });
    s.mfaGate.g = gate();
    const done = d.call(s, "rt-old");
    await until(() => s.f.count(d.path) === 1); // in flight, holding the lock
    const refresh = drive(s.mw as never, refreshReq("rt-old"));
    await sleep(150); // the refresh reaches the lock and waits
    s.mfaGate.g.open();
    await done;
    const r = await refresh;
    assert.equal(r.res.statusCode, 503, "refresh adopts nothing, mints nothing");
    assert.equal(lastCookie(r.res.setCookie), d.minted, "handed the rotated token");
    assert.equal(s.issuerMints(), 1, "only the verify's own /auth/token mint (R51) reached the issuer");
    assert.ok(!s.seen.includes("rt-old"), "the spent token was never re-presented");
  });

  test(`TestDirectMFA_StoreErrorOnAcquireIsErrorAndIssuerNotCalled [${d.name}]`, async () => {
    const s = await setup({ store: wrapStore(createMemorySessionStore(), { acquireRefreshLock: async () => { throw new Error("redis down"); } }) });
    await assert.rejects(d.call(s, "rt-old"), (e: RealmError) => e.code === "server_error" && e.httpStatus === 503 && /session store unavailable/.test(e.message));
    assert.equal(s.f.count(d.path), 0);
  });

  test(`TestDirectMFA_LockHeldPastWaitsIs503AndIssuerNotCalled [${d.name}]`, { timeout: 10_000 }, async () => {
    const inner = createMemorySessionStore({ now: () => Date.now() });
    const s = await setup({ store: inner });
    await inner.acquireRefreshLock(await lockKey("rt-old"), 60_000);
    await assert.rejects(d.call(s, "rt-old"), (e: RealmError) => e.code === "server_error" && e.httpStatus === 503 && /refresh in progress/.test(e.message));
    assert.equal(s.f.count(d.path), 0);
  });

  test(`TestDirectMFA_MintFailureStillStoresRotatedOutcome [${d.name}]`, async () => {
    const inner = createMemorySessionStore({ now: () => Date.now() });
    const s = await setup({ store: inner, hook: () => { throw new Error("partner db down"); } });
    await assert.rejects(d.call(s, "rt-old"), (e: Error) => e.name === "LoginMintError");
    const stored = JSON.parse((await inner.getRefreshResult(await outKey("rt-old")))!);
    assert.equal(stored.refreshToken, d.rotated, "the rotation already happened; a waiting refresh must adopt it");
  });

  test(`TestDirectMFA_ErrorStoresNothing [${d.name}]: an issuer refusal rotated nothing`, async () => {
    const inner = createMemorySessionStore({ now: () => Date.now() });
    const s = await setup({ store: inner });
    s.f.mfaVerify = () => jsonRes(401, { error: { code: "unauthorized", message: "bad" } });
    s.f.recovery = () => jsonRes(401, { error: { code: "unauthorized", message: "bad" } });
    await assert.rejects(d.call(s, "rt-old"));
    assert.equal(await inner.getRefreshResult(await outKey("rt-old")), undefined);
    assert.equal((await inner.acquireRefreshLock(await lockKey("rt-old"), 1000)).acquired, true, "lock released on error too");
  });
}

test("TestDirectMFA_WorkUnderTheLockIsBounded: a hung issuer call is cut at the 10 s mint bound, lock freed", { timeout: 25_000 }, async () => {
  const inner = createMemorySessionStore({ now: () => Date.now() });
  const s = await setup({ store: inner });
  s.mfaGate.g = gate(); // never opened inside the bound
  await assert.rejects(
    s.realm.auth.mfaVerify({ challengeToken: "c", code: "1", refreshToken: "rt-old" }),
    (e: RealmError) => e.code === "server_error" && e.httpStatus === 504,
  );
  assert.equal((await inner.acquireRefreshLock(await lockKey("rt-old"), 1000)).acquired, true);
  s.mfaGate.g.open();
});

test("TestDirectMFA_MiddlewareHandlersTakeTheLockExactlyOnce: they leave refreshToken unset (the lock is not re-entrant)", async () => {
  let acquires = 0;
  const inner = createMemorySessionStore({ now: () => Date.now() });
  const s = await setup({
    store: wrapStore(inner, { acquireRefreshLock: async (k, t) => { acquires++; return inner.acquireRefreshLock(k, t); } }),
    mw: { recoveryPath: "/mfa/recovery" },
  });
  for (const url of ["/mfa/verify", "/mfa/recovery"]) {
    acquires = 0;
    const t0 = Date.now();
    const r = await drive(s.mw as never, { url, method: "POST", headers: cookie("rt-x" + url.length), body: recBody });
    assert.equal(r.res.statusCode, 200, url);
    assert.equal(acquires, 1, `${url}: exactly one acquire`);
    assert.ok(Date.now() - t0 < 1000, `${url}: a re-entrant acquire would wait out the lock`);
  }
});

test("TestMiddlewareMFARoutes_MintFailureStillStoresRotatedOutcome: a refresh waiting behind is handed the rotated token", async () => {
  const inner = createMemorySessionStore({ now: () => Date.now() });
  const s = await setup({ store: inner, mw: { recoveryPath: "/mfa/recovery" }, hook: () => { throw new Error("partner db down"); } });
  for (const [url, rt, rotated] of [["/mfa/verify", "rt-a", "rt-mfa-1"], ["/mfa/recovery", "rt-b", "rt-rec-1"]] as const) {
    const r = await drive(s.mw as never, { url, method: "POST", headers: cookie(rt), body: recBody });
    assert.notEqual(r.res.statusCode, 200, url);
    const stored = JSON.parse((await inner.getRefreshResult(await outKey(rt)))!);
    assert.equal(stored.refreshToken, rotated, url);
    assert.equal(lastCookie(r.res.setCookie), rotated, `${url}: the client keeps the live token, not the spent cookie`);
  }
});

// ------------------------------------------------------------- auth.token lock

const tokenAsync = (s: S, rt: string, extra: Record<string, unknown> = {}) =>
  s.realm.auth.token({ refreshToken: rt, tenantId: "acme", ...extra });

test("TestToken_ConcurrentCallsMintOnceAndLoserAdoptsTheWinner", async () => {
  const s = await setup();
  s.tokenGate.g = gate();
  const a = tokenAsync(s, "rt-old");
  await until(() => s.issuerMints() === 1 || s.seen.length === 1);
  const b = tokenAsync(s, "rt-old");
  await sleep(150);
  s.tokenGate.g.open();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(s.seen.length, 1, "issuer minted once");
  assert.equal(ra.accessToken, rb.accessToken);
  assert.equal(ra.refreshToken, "rt-new-1");
  assert.equal(rb.refreshToken, "rt-new-1");
});

test("TestToken_DifferentRequestShapeRetriesOnTheRotatedToken", async () => {
  const s = await setup();
  s.tokenGate.g = gate();
  const a = tokenAsync(s, "rt-old");
  await until(() => s.seen.length === 1);
  const b = tokenAsync(s, "rt-old", { customClaims: { k: 1 } });
  await sleep(150);
  s.tokenGate.g.open();
  const [, rb] = await Promise.all([a, b]);
  assert.deepEqual(s.seen, ["rt-old", "rt-new-1"], "the loser never re-presents the spent token");
  assert.equal(rb.refreshToken, "rt-new-2");
});

test("TestToken_RacingDirectMFAVerifyUsesTheRotatedToken", async () => {
  const s = await setup();
  s.mfaGate.g = gate();
  const m = s.realm.auth.mfaVerify({ challengeToken: "c", code: "1", refreshToken: "rt-old" });
  await until(() => s.f.count("/auth/mfa/verify") === 1);
  const t = tokenAsync(s, "rt-old");
  await sleep(150);
  s.mfaGate.g.open();
  await m;
  const r = await t;
  // R51: the verify spends rt-mfa-1 in its own mint; the racing token call then runs on THAT mint's rotated token.
  assert.deepEqual(s.seen, ["rt-mfa-1", "rt-new-1"], "never the spent rt-old");
  assert.equal(r.refreshToken, "rt-new-2");
});

test("TestToken_StoresItsOutcomeBeforeReleasingAndLateRepeatReusesIt", async () => {
  const s = await setup();
  const a = await tokenAsync(s, "rt-old");
  const again = await tokenAsync(s, "rt-old");
  assert.equal(s.seen.length, 1);
  assert.equal(again.accessToken, a.accessToken);
});

test("TestToken_WinnerErrorIsSharedWithTheLoser", async () => {
  const s = await setup();
  s.f.token = async (b) => { s.seen.push(String(b["refresh_token"])); await sleep(100); return jsonRes(401, { error: { code: "refresh_invalid", message: "dead" } }); };
  const [a, b] = await Promise.allSettled([tokenAsync(s, "rt-old"), tokenAsync(s, "rt-old")]);
  assert.equal(a.status, "rejected");
  assert.equal(b.status, "rejected");
  assert.equal((b as PromiseRejectedResult).reason.code, "refresh_invalid");
  assert.equal(s.seen.length, 1);
});

test("TestToken_LockFailuresFailClosed", async () => {
  const s = await setup({ store: wrapStore(createMemorySessionStore(), { acquireRefreshLock: async () => { throw new Error("redis down"); } }) });
  await assert.rejects(tokenAsync(s, "rt-old"), (e: RealmError) => e.code === "server_error" && e.httpStatus === 503);
  assert.equal(s.seen.length, 0);
});

test("TestToken_EmptyRefreshTokenTakesNoLock", async () => {
  let acquires = 0;
  const inner = createMemorySessionStore();
  const s = await setup({ store: wrapStore(inner, { acquireRefreshLock: async (k, t) => { acquires++; return inner.acquireRefreshLock(k, t); } }) });
  await s.realm.auth.token({ refreshToken: "", tenantId: "acme" });
  assert.equal(acquires, 0);
  assert.equal(s.seen.length, 1);
});

test("TestSelfEnrollMFA_TakesNoLock", async () => {
  let acquires = 0;
  const inner = createMemorySessionStore();
  const s = await setup({ store: wrapStore(inner, { acquireRefreshLock: async (k, t) => { acquires++; return inner.acquireRefreshLock(k, t); } }) });
  await s.realm.auth.selfEnrollMfa({ refreshToken: "rt-old", tenantId: "acme" }).catch(() => undefined);
  assert.equal(acquires, 0);
});

test("TestToken_InternalCallersNeverDoubleLock: login/mfa mints and middleware refresh take at most their own single lock", async () => {
  let acquires = 0;
  const inner = createMemorySessionStore({ now: () => Date.now() });
  const s = await setup({
    store: wrapStore(inner, { acquireRefreshLock: async (k, t) => { acquires++; return inner.acquireRefreshLock(k, t); } }),
    hook: () => undefined,
    // R51: the post-verify mint always runs (the old "no handler + access_token: return early" skip is gone); a
    // configured productRoles handler additionally adds the claim to it.
    productRoles: async () => ["viewer"],
  });
  await s.realm.auth.mfaVerify({ challengeToken: "c", code: "1", refreshToken: "rt-old" });
  assert.equal(refreshCount(s.f), 1, "the post-verify inner mint really ran");
  assert.equal(acquires, 1, "direct MFA lock only; its inner mint does not re-lock");
  acquires = 0;
  const r = await drive(s.mw as never, refreshReq("rt-m"));
  assert.equal(r.res.statusCode, 200);
  assert.equal(refreshCount(s.f), 3, "refresh mint plus its derived-claims re-mint both ran");
  assert.equal(acquires, 1, "middleware refresh lock only; its mint and enrichment do not re-lock");
});

test("TestToken_OnlyTokenLevelErrorOutcomesAreSharedAcrossShapes", async () => {
  const seed = async (inner: SessionStateStore, key: string, status: number, code: string) =>
    inner.putRefreshResult(await outKey(key), JSON.stringify({
      fp: "someone-else", ok: false, status, body: { error: { code, message: "m" } },
    }), 60_000);
  {
    const inner = createMemorySessionStore({ now: () => Date.now() });
    const s = await setup({ store: inner });
    await seed(inner, "rt-old", 401, "refresh_invalid");
    await assert.rejects(tokenAsync(s, "rt-old"), (e: RealmError) => e.code === "refresh_invalid");
    assert.equal(s.seen.length, 0, "refresh_invalid is shared");
  }
  {
    const inner = createMemorySessionStore({ now: () => Date.now() });
    const s = await setup({ store: inner });
    await seed(inner, "rt-old", 401, "unauthorized");
    await assert.rejects(tokenAsync(s, "rt-old"), (e: RealmError) => e.code === "unauthorized");
    assert.equal(s.seen.length, 0, "a spent-token 401 is shared");
  }
  {
    const inner = createMemorySessionStore({ now: () => Date.now() });
    const s = await setup({ store: inner });
    await seed(inner, "rt-old", 403, "forbidden");
    const r = await tokenAsync(s, "rt-old");
    assert.equal(r.refreshToken, "rt-new-1");
    assert.deepEqual(s.seen, ["rt-old"], "a shape-specific 403 is not shared: this request mints for itself");
  }
});

test("TestToken_OutcomeReadErrorNeverMints / TestMiddlewareRefresh_OutcomeReadErrorNeverMints", async () => {
  const inner = createMemorySessionStore({ now: () => Date.now() });
  const s = await setup({ store: wrapStore(inner, { getRefreshResult: async () => { throw new Error("redis read failed"); } }) });
  await assert.rejects(tokenAsync(s, "rt-old"), (e: RealmError) => e.code === "server_error" && e.httpStatus === 503 && /session store unavailable/.test(e.message));
  assert.equal(s.seen.length, 0, "could not tell whether a winner already rotated: no mint");
  const r = await drive(s.mw as never, refreshReq("rt-old"));
  assert.equal(r.res.statusCode, 503);
  assert.equal((r.res.json["error"] as Record<string, unknown>)["message"], "session store unavailable");
  assert.equal(s.seen.length, 0);
});

test("TestToken_SupersededGiveUpCarriesTheTokenRedacted", async () => {
  const inner = createMemorySessionStore({ now: () => Date.now() });
  const s = await setup({ store: inner });
  const chain = ["rt-old", "rt-1", "rt-2", "rt-SECRET"];
  for (let i = 0; i + 1 < chain.length; i++) {
    await inner.putRefreshResult(await outKey(chain[i]!), JSON.stringify({ fp: "someone-else", ok: true, refreshToken: chain[i + 1] }), 60_000);
  }
  let err: unknown;
  try { await tokenAsync(s, "rt-old"); } catch (e) { err = e; }
  assert.ok(err instanceof RefreshSupersededError);
  assert.ok(err instanceof RealmError);
  assert.equal((err as RefreshSupersededError).refreshToken(), "rt-SECRET");
  assert.equal((err as RealmError).code, "server_error");
  assert.equal((err as RealmError).httpStatus, 503);
  for (const out of [String(err), (err as Error).message, JSON.stringify(err), inspect(err, { depth: 6, showHidden: true }), `${(err as Error).stack}`]) {
    assert.ok(!out.includes("rt-SECRET"), `live refresh token leaked: ${out.slice(0, 80)}`);
  }
  assert.equal(s.seen.length, 0, "the issuer must not be called");
});

test("TestTokenManager_AdoptsTheTokenFromASupersededGiveUp (and persists it to the sink)", async () => {
  const inner = createMemorySessionStore({ now: () => Date.now() });
  const s = await setup({ store: inner });
  const chain = ["rt-old", "rt-1", "rt-2", "rt-3"];
  for (let i = 0; i + 1 < chain.length; i++) {
    await inner.putRefreshResult(await outKey(chain[i]!), JSON.stringify({ fp: "someone-else", ok: true, refreshToken: chain[i + 1] }), 60_000);
  }
  const sunk: string[] = [];
  const m = s.realm.auth.newTokenManager("rt-old", { refreshSink: (t) => { sunk.push(t); } });
  await assert.rejects(m.accessToken(), (e: unknown) => e instanceof RefreshSupersededError);
  assert.equal(m.refreshToken(), "rt-3", "the next attempt presents the live token, not the spent one");
  assert.deepEqual(sunk, ["rt-3"], "persisted exactly as after a normal rotation");
});

test("TestTokenManager_TwoManagersOnOneSessionMintOnce", async () => {
  const s = await setup();
  s.tokenGate.g = gate();
  const m1 = s.realm.auth.newTokenManager("rt-old", { tenantId: "acme" });
  const m2 = s.realm.auth.newTokenManager("rt-old", { tenantId: "acme" });
  const a = m1.accessToken();
  await until(() => s.seen.length === 1);
  const b = m2.accessToken();
  await sleep(150);
  s.tokenGate.g.open();
  const [ta, tb] = await Promise.all([a, b]);
  assert.equal(s.seen.length, 1);
  assert.equal(ta, tb);
});

// -------------------------------------------------------------- memory sweep

test("TestMemorySessionStore_SweepsExpiredOutcomesAndLocks / SweepSparesLiveRevocations", async () => {
  let t = 1_000_000;
  const st = createMemorySessionStore({ now: () => t });
  await st.putRefreshResult("first", "x", 1000);
  await st.revokeSession("sid-live", t + 3_600_000);
  for (let i = 0; i < 50; i++) {
    await st.putRefreshResult(`k${i}`, "live-token", 5000);
    await st.acquireRefreshLock(`k${i}`, 15_000); // abandoned, never released
  }
  t += 120_000; // past the 30 s sweep interval, revocation has ~58 min left
  await st.putRefreshResult("late", "x", 5000);
  await st.acquireRefreshLock("late", 15_000);
  const sizes = (st as unknown as { __sizes?: () => { results: number; locks: number; entries: number } }).__sizes?.();
  assert.ok(sizes, "memory store exposes sizes for the sweep pin");
  assert.deepEqual({ r: sizes!.results, l: sizes!.locks }, { r: 1, l: 1 }, "expired entries must not accumulate");
  assert.equal((await st.sessionStates(["sid-live"]))[0]!.revoked, true, "a live revocation was swept");
});

// ------------------------------------------------- SPEC §6.7.2 store bounds

test("TestSPEC6_7_2_HungStoreReadFailsOpenAtTheStoreTimeout and CancelledRequestIsNotAStoreError", async () => {
  const { TokensClient } = await import("./tokens.js");
  const inner = createMemorySessionStore({ now: () => Date.now() });
  const seenArgs: unknown[][] = [];
  let hang = false;
  const store = wrapStore(inner, {
    sessionStates: (...a: [string[]]) => { seenArgs.push(a); return hang ? new Promise(() => undefined) : inner.sessionStates(...a); },
  });
  const warns: string[] = [];
  const tc = new TokensClient(store, { now: () => NOW * 1000, storeTimeoutMs: 60, logger: { debug() {}, info() {}, warn: (m: string) => { warns.push(m); }, error() {} } as never });
  const { peekJwt } = await import("./v063-fixture.test.js");
  const tok = peekJwt(claimsFor(NOW));
  await tc.revokeSession("s1");
  assert.equal(await tc.isRevoked(tok), true);
  assert.deepEqual(seenArgs[0]!.length, 1, "no request signal is handed to a store read: nothing a client hang-up can abort");
  hang = true;
  const t0 = Date.now();
  assert.equal(await tc.isRevoked(tok), false, "a store that never answers fails open, once, at the store timeout");
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(warns.length, 1);
});

test("TestSPEC6_7_2_HungStoreWriteIsBoundedAndLogged", async () => {
  const { TokensClient } = await import("./tokens.js");
  const warns: string[] = [];
  const store = wrapStore(createMemorySessionStore(), { revokeSession: () => new Promise(() => undefined) });
  const tc = new TokensClient(store, { storeTimeoutMs: 60, logger: { debug() {}, info() {}, warn: (m: string) => { warns.push(m); }, error() {} } as never });
  const t0 = Date.now();
  await tc.revokeSession("s1");
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(warns.length, 1);
});
