import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Verifier } from "./verifier.js";
import { createRealm } from "./realm.js";
import { RealmError } from "./errors.js";
import { TokensClient, TokenRevokedError } from "./tokens.js";
import { createMemorySessionStore, type SessionStateStore } from "./session-store.js";
import { peekJwtRevokeFields, MemRevocationCache } from "./revocation.js";
import { OrgSessionModeResolver } from "./org-session.js";
import { decideScope, createScopeMiddleware, fastifyScopeHook } from "./scope.js";
import { globMatch } from "./middleware.js";
import { AUD, BASE, REALM, claimsFor, fakeIssuer, jsonRes, makeSigner, peekJwt } from "./v063-fixture.test.js";

const NOW_S = 1_800_000_000;
const H = 24 * 3600 * 1000;

function mkTokens(opts: { mode?: "concurrent" | "exclusive"; store?: SessionStateStore; now?: () => number } = {}) {
  let now = NOW_S * 1000;
  const clock = opts.now ?? (() => now);
  const store = opts.store ?? createMemorySessionStore({ now: clock });
  const logs: string[] = [];
  const t = new TokensClient(store, {
    now: clock,
    orgMode: async () => opts.mode ?? "concurrent",
    logger: { debug() {}, info() {}, warn: (m: string) => { logs.push(m); }, error() {} } as never,
  });
  return { t, store, logs, advance: (ms: number) => { now += ms; } };
}

// ---- SPEC6_7: session key, lifetime, marks ----

test("SPEC6_7 #18-20 sessionKey: sid wins over jti; jti-only token (prod shape) is the session", async () => {
  assert.equal(peekJwtRevokeFields(peekJwt({ sid: "S", jti: "J" })).sessionKey, "S");
  assert.equal(peekJwtRevokeFields(peekJwt({ jti: "J" })).sessionKey, "J");
  assert.equal(peekJwtRevokeFields(peekJwt({ sid: "", jti: "J" })).sessionKey, "J");
  assert.equal(peekJwtRevokeFields(peekJwt({})).sessionKey, "");
  const { t } = mkTokens();
  await t.markRevoked(peekJwt({ sid: "S", jti: "J1", exp: NOW_S + 10, iat: NOW_S }));
  assert.equal(await t.isRevoked(peekJwt({ sid: "S", jti: "J2", exp: NOW_S + 10, iat: NOW_S })), true);
  const b = mkTokens();
  await b.t.markRevoked(peekJwt({ jti: "J" }));
  assert.equal(await b.t.isRevoked(peekJwt({ jti: "J" })), true);
  assert.equal(await b.t.isRevoked(peekJwt({ jti: "K" })), false);
});

test("SPEC6_7 #22-23a markRevoked lives to now+24h, never shortens, needs no exp", async () => {
  const { t, advance } = mkTokens();
  const expired = peekJwt({ sid: "S", exp: NOW_S - 1000, iat: NOW_S - 2000 });
  await t.markRevoked(expired);
  assert.equal(await t.isRevoked(peekJwt({ sid: "S", exp: NOW_S + 900, iat: NOW_S })), true);
  advance(H - 1000);
  assert.equal(await t.isRevoked(peekJwt({ sid: "S" })), true);
  advance(1000);
  assert.equal(await t.isRevoked(peekJwt({ sid: "S" })), false);
  await t.revokeSession("Q");
  await t.revokeSession("");
  assert.equal(await t.isRevoked(peekJwt({ sid: "Q" })), true);
});

test("SPEC6_7 #24-27 recordRefresh: strictly-less refused, monotonic, no iat refused, no sub no-op", async () => {
  const { t } = mkTokens();
  await t.recordRefresh(peekJwt({ sid: "S", sub: "m", iat: NOW_S }));
  const tok = (iat: number | undefined) => peekJwt({ sid: "S", sub: "m", ...(iat === undefined ? {} : { iat }) });
  assert.equal(await t.isRevoked(tok(NOW_S - 1)), true);
  assert.equal(await t.isRevoked(tok(NOW_S)), false);
  assert.equal(await t.isRevoked(tok(NOW_S + 1)), false);
  assert.equal(await t.isRevoked(tok(undefined)), true);
  await t.recordRefresh(peekJwt({ sid: "S", sub: "m", iat: NOW_S - 50 }));
  assert.equal(await t.isRevoked(tok(NOW_S - 1)), true, "mark never lowered");
  const n = mkTokens();
  await n.t.recordRefresh(peekJwt({ sid: "S", iat: NOW_S }));
  assert.equal(await n.t.isRevoked(peekJwt({ sid: "S", sub: "m", iat: NOW_S - 5 })), false, "no sub: nothing written");
});

test("SPEC6_7 #26 mark lifetime is now+24h", async () => {
  const { t, advance } = mkTokens();
  await t.recordRefresh(peekJwt({ sid: "S", sub: "m", iat: NOW_S }));
  advance(H - 1000);
  assert.equal(await t.isRevoked(peekJwt({ sid: "S", sub: "m", iat: NOW_S - 1 })), true);
  advance(1000);
  assert.equal(await t.isRevoked(peekJwt({ sid: "S", sub: "m", iat: NOW_S - 1 })), false);
});

test("SPEC6_7 #28 gateRequest throws TokenRevokedError on a superseded token", async () => {
  const { t } = mkTokens();
  await t.recordRefresh(peekJwt({ sid: "S", sub: "m", iat: NOW_S }));
  await assert.rejects(() => t.gateRequest(peekJwt({ sid: "S", sub: "m", iat: NOW_S - 1 })), (e: unknown) => {
    assert.ok(e instanceof TokenRevokedError);
    assert.equal((e as RealmError).code, "unauthorized");
    assert.equal((e as RealmError).details?.["revoked"], true);
    return true;
  });
});

test("SPEC6_7 #29 revokeOnLogout peeks before the call and marks on failure too", async () => {
  const { t } = mkTokens();
  let token = peekJwt({ sid: "S", exp: NOW_S + 60, iat: NOW_S });
  const orig = token;
  const wrapped = t.revokeOnLogout(async () => { token = peekJwt({ sid: "OTHER" }); throw new Error("net"); });
  await assert.rejects(() => wrapped(token));
  assert.equal(await t.isRevoked(orig), true);
});

test("SPEC6_7 #30 evict(sessionKey) clears revoked + both marks; evict('') on a shared store is a no-op + warning", async () => {
  const { t } = mkTokens();
  await t.markRevoked(peekJwt({ sid: "S" }));
  await t.recordRefresh(peekJwt({ sid: "S", sub: "m", iat: NOW_S }));
  await t.evict("S");
  assert.equal(await t.isRevoked(peekJwt({ sid: "S", sub: "m", iat: 1 })), false);
  const spyCalls: string[] = [];
  const inner = createMemorySessionStore();
  const shared: SessionStateStore = { ...inner, evict: async (p) => { spyCalls.push(p); } };
  const m = mkTokens({ store: shared });
  await m.t.evict("");
  assert.deepEqual(spyCalls, []);
  assert.equal(m.logs.length, 1);
});

test("SPEC6_7 #31-32 store read error fails open + one warning; write errors never throw", async () => {
  const inner = createMemorySessionStore();
  const bad: SessionStateStore = {
    ...inner,
    sessionStates: async () => { throw new Error("boom"); },
    revokeSession: async () => { throw new Error("boom"); },
    raiseNotBefore: async () => { throw new Error("boom"); },
  };
  const { t, logs } = mkTokens({ store: bad });
  assert.equal(await t.isRevoked(peekJwt({ sid: "S", sub: "m", iat: 1 })), false);
  assert.equal(logs.length, 1);
  await t.markRevoked(peekJwt({ sid: "S" }));
  await t.revokeSession("S");
  await t.recordRefresh(peekJwt({ sid: "S", sub: "m", iat: 5 }));
});

test("SPEC6_7_5 #34 createRealm requires an explicit sessionStore (invalid_config)", () => {
  assert.throws(
    () => createRealm({ realmId: "r1", apiKey: "rk_live_x", baseUrl: BASE }),
    (e: unknown) => e instanceof RealmError && e.code === "invalid_config" && /createMemorySessionStore\(\)/.test(e.message) && /sessionStore/.test(e.message),
  );
});

test("SPEC6_7_5 #36a key namespaces are exact and escaped; nothing under sub|", async () => {
  const calls: string[] = [];
  const inner = createMemorySessionStore();
  const spy: SessionStateStore = {
    ...inner,
    revokeSession: async (k, u) => { calls.push(`rev:${k}`); return inner.revokeSession(k, u); },
    raiseNotBefore: async (k, n, u) => { calls.push(`nb:${k}`); return inner.raiseNotBefore(k, n, u); },
  };
  const { t } = mkTokens({ store: spy });
  await t.markRevoked(peekJwt({ sid: "S" }));
  await t.recordRefresh(peekJwt({ sid: "a|b%", sub: "c", iat: NOW_S }));
  assert.deepEqual(calls, ["rev:realmid:v1:rev|S", "nb:realmid:v1:nb|a%7Cb%25", "nb:realmid:v1:nb|a%7Cb%25|c"]);
  assert.ok(!calls.some((c) => c.includes("sub|")));
});

test("SPEC6_7_3 #37a-c mode selects the mark; switch applies at check time", async () => {
  const marks = { Acme: peekJwt({ sid: "S", sub: "u-acme", iat: NOW_S - 10 }) };
  for (const [mode, acmeRefused] of [["concurrent", false], ["exclusive", true]] as const) {
    const { t } = mkTokens({ mode });
    await t.recordRefresh(peekJwt({ sid: "S", sub: "u-globex", iat: NOW_S }));
    assert.equal(await t.isRevoked(marks.Acme), acmeRefused, mode);
    assert.equal(await t.isRevoked(peekJwt({ sid: "S", sub: "u-globex", iat: NOW_S - 1 })), true);
  }
  let mode: "concurrent" | "exclusive" = "concurrent";
  const store = createMemorySessionStore();
  const t = new TokensClient(store, { orgMode: async () => mode, now: () => NOW_S * 1000 });
  await t.recordRefresh(peekJwt({ sid: "S", sub: "u-globex", iat: NOW_S }));
  assert.equal(await t.isRevoked(marks.Acme), false);
  mode = "exclusive";
  assert.equal(await t.isRevoked(marks.Acme), true);
});

test("SPEC6_7_3 #37d-f discovery: URL, 10-min cache, fail-soft to concurrent, field name", async () => {
  const { publicJwk } = await makeSigner();
  const f = fakeIssuer(publicJwk);
  let now = NOW_S * 1000;
  const warns: string[] = [];
  const r = new OrgSessionModeResolver({ baseUrl: BASE, fetch: f.fetch, now: () => now, logger: { debug() {}, info() {}, warn: (m: string) => { warns.push(m); }, error() {} } as never });
  f.discovery = { status: 200, body: { realmid_org_sessions: "exclusive" } };
  assert.equal(await r.get(REALM), "exclusive");
  assert.equal(await r.get(REALM), "exclusive");
  assert.equal(f.count("/.well-known/openid-configuration"), 1);
  assert.equal(f.calls[0]!.url, `${BASE}/${REALM}/.well-known/openid-configuration`);
  now += 10 * 60 * 1000 + 1000;
  f.discovery = { status: 200, body: { org_sessions: "exclusive" } };
  assert.equal(await r.get(REALM), "concurrent", "differently named field");
  for (const [body, status] of [[{ realmid_org_sessions: "" }, 200], [{ realmid_org_sessions: "both" }, 200], [{}, 500], ["not json{", 200]] as const) {
    now += 11 * 60 * 1000;
    f.discovery = { status, body };
    assert.equal(await r.get(REALM), "concurrent");
  }
  assert.ok(warns.length >= 1);
});

test("SPEC6_7_6 #89-90,95 Config.Revocation keys on the session; v0.62 jti entries still match", async () => {
  const { publicJwk, sign } = await makeSigner();
  const f = fakeIssuer(publicJwk);
  const rev = new MemRevocationCache(() => NOW_S * 1000);
  const v = new Verifier({ baseUrl: BASE, audience: AUD, fetch: f.fetch, now: () => new Date(NOW_S * 1000), revocation: rev });
  await rev.revoke("S", NOW_S * 1000 + H);
  const unauth = (e: unknown) => e instanceof RealmError && e.code === "unauthorized";
  await assert.rejects(async () => v.verify(await sign(claimsFor(NOW_S, { sid: "S", jti: "unique-1" }))), unauth);
  await assert.rejects(async () => v.verify(await sign(claimsFor(NOW_S, { sid: undefined, jti: "S" }))), unauth);
  assert.equal((await v.verify(await sign(claimsFor(NOW_S, { sid: "T", jti: "T" })))).sid, "T");
});

// ---- SPEC5_1 / 5_1_1 ----

async function verifierFixture() {
  const { publicJwk, sign } = await makeSigner();
  const f = fakeIssuer(publicJwk);
  const spy = { revocation: 0, authority: 0 };
  const v = new Verifier({
    baseUrl: BASE, audience: AUD, fetch: f.fetch, now: () => new Date(NOW_S * 1000),
    revocation: { revoke: async () => {}, isRevoked: async () => { spy.revocation++; return false; } },
    authority: { markStale: async () => {}, staleSince: async () => { spy.authority++; return null; } },
  });
  return { v, sign, f, spy };
}

const malformed = (re?: RegExp) => (e: unknown) => e instanceof RealmError && e.code === "malformed" && (re ? re.test(e.message) : true);

test("SPEC5_1 #1-5 blank/absent/non-string sub is malformed, before the authority cache", async () => {
  const { v, sign, spy } = await verifierFixture();
  for (const sub of [undefined, "", "   ", "\t\n", 5, null]) {
    const tok = await sign(claimsFor(NOW_S, { sub }));
    await assert.rejects(() => v.verify(tok), malformed(), JSON.stringify(sub));
  }
  assert.equal(spy.authority, 0);
  assert.equal(spy.revocation, 0);
  assert.equal((await v.verify(await sign(claimsFor(NOW_S, { sub: " " })))).sub, " ");
  assert.equal((await v.verify(await sign(claimsFor(NOW_S)))).sub, "u-acme");
});

test("SPEC5_1_1 #6-10 typ allowlist, case-insensitive, no trimming", async () => {
  const { v, sign } = await verifierFixture();
  await assert.rejects(async () => v.verify(await sign(claimsFor(NOW_S), { typ: undefined })), malformed(/unexpected token type: <absent>/));
  for (const typ of ["logout+jwt", " JWT", "at+jwt ", 42]) {
    await assert.rejects(async () => v.verify(await sign(claimsFor(NOW_S), { typ })), malformed(), String(typ));
  }
  for (const typ of ["JWT", "jwt", "Jwt", "at+jwt", "AT+JWT", "application/at+jwt", "Application/AT+JWT"]) {
    await v.verify(await sign(claimsFor(NOW_S), { typ }));
  }
});

test("SPEC5_1_1 #11 typ is refused before any JWKS fetch", async () => {
  const { v, sign, f } = await verifierFixture();
  await assert.rejects(async () => v.verify(await sign(claimsFor(NOW_S), { typ: "logout+jwt", kid: "nope" })), malformed());
  assert.equal(f.count("/jwks.json"), 0);
});

test("SPEC5_1_1 #12-15 events claim refused, before both caches; ADR-110 logout token refused", async () => {
  const { v, sign, spy } = await verifierFixture();
  for (const events of [{ "http://schemas.openid.net/event/backchannel-logout": {} }, {}, null, ["signup"]]) {
    await assert.rejects(async () => v.verify(await sign(claimsFor(NOW_S, { events }))), malformed(/token carries an events claim/));
  }
  await assert.rejects(async () => v.verify(await sign(claimsFor(NOW_S, { events: {}, sub: undefined }), { typ: "logout+jwt" })), malformed());
  assert.equal(spy.revocation + spy.authority, 0);
});

// ---- SPEC10_2_paths / SPEC11 ----

test("SPEC10_2_paths #68-72 /x/** matches bare /x; {name} one non-empty segment (mfa/scope), exempt literal", () => {
  assert.equal(globMatch("/x/**", "/x"), true);
  assert.equal(globMatch("/x/**", "/x/"), true);
  assert.equal(globMatch("/x/**", "/x/a/b"), true);
  assert.equal(globMatch("/x/**", "/xy"), false);
  assert.equal(globMatch("/orders/{id}", "/orders/{id}"), true, "default (exempt) matching stays literal");
  assert.equal(globMatch("/hooks/{id}", "/hooks/abc"), false);
  assert.equal(globMatch("/orders/{id}", "/orders/42", { braces: true }), true);
  assert.equal(globMatch("/orders/{id}", "/orders/", { braces: true }), false);
  assert.equal(globMatch("/orders/{id}", "/orders/42/items", { braces: true }), false);
  assert.equal(globMatch("/orders/{id}", "/orders/42/", { braces: true }), false);
  assert.equal(globMatch("/orders/{id}", "/orders//42", { braces: true }), false);
  assert.equal(globMatch("/orders/*", "/orders/", { braces: true }), true);
  assert.throws(() => globMatch("/v{n}/x", "/v1/x", { braces: true }));
  assert.throws(() => globMatch("/files/{id}.json", "/files/1.json", { braces: true }));
});

test("SPEC11_4 #70,74 ScopeRule /x/** matches bare /x; missing on anyOf is the full set", () => {
  const claims = { scope: "z:z" } as never;
  const d = decideScope([{ path: "/x/**", scopes: ["a:a", "b:b"], anyOf: true }], claims, "GET", "/x");
  assert.equal(d.matched, true);
  assert.deepEqual(d.missing, ["a:a", "b:b"]);
  const all = decideScope([{ path: "/o/{id}", scopes: ["a:a", "z:z"] }], claims, "GET", "/o/42");
  assert.deepEqual(all.missing, ["a:a"]);
});

test("SPEC11_5_1 #76 writeDenied: unset = golden bytes; set = onScopeDenied then writeDenied, status 403, response ended", async () => {
  const GOLDEN = '{"error":{"code":"insufficient_scope","message":"this token does not carry the scope required for this route"}}';
  const mkRes = () => ({ statusCode: 200, writableEnded: false, body: "", setHeader() {}, end(c?: string) { this.body += c ?? ""; this.writableEnded = true; } });
  const r1 = mkRes();
  createScopeMiddleware([])({ method: "GET", url: "/x" }, r1, () => assert.fail());
  assert.equal(r1.statusCode, 403);
  assert.equal(r1.body, GOLDEN);
  const order: string[] = [];
  const r2 = mkRes();
  const mw = createScopeMiddleware([], {
    onScopeDenied: () => { order.push("on"); },
    writeDenied: async () => { order.push("write"); },
  });
  mw({ method: "GET", url: "/x" }, r2, () => assert.fail());
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ["on", "write"]);
  assert.equal(r2.statusCode, 403);
  assert.equal(r2.writableEnded, true);
  const errs: unknown[] = [];
  createScopeMiddleware([], { writeDenied: async () => { throw new Error("w"); } })({ method: "GET", url: "/x" }, mkRes(), (e) => errs.push(e));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(errs.length, 1);
  // fastify: missing hijack/raw with writeDenied set -> done(TypeError)
  let doneErr: unknown;
  fastifyScopeHook([], { writeDenied: () => {} })({ method: "GET", url: "/x" }, { code: () => ({ send: () => {} }) } as never, (e) => { doneErr = e; });
  assert.ok(doneErr instanceof TypeError);
});
