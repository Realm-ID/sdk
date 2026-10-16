/**
 * ADR-104 § Owner rulings R-e (ts parity with go 0.65.0): the three
 * whole-identity revokes return `revoked_sids`, and the SDK writes each into the
 * SessionStore exactly as logout does. Mirrors go/revoked_sids_test.go.
 *
 * Wire shapes are the issuer's real ones: /auth/login is `raw(...)` (bare);
 * /me/password and the reset consume are plain-map handlers, so GoFr wraps them
 * as `{"data":{...}}`.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { createMemorySessionStore, type SessionStateStore } from "./session-store.js";
import { AUD, BASE, REALM, claimsFor, drive, fakeIssuer, jsonRes, makeSigner } from "./v063-fixture.test.js";

const NOW = 1_800_000_000;

async function env(extra: Record<string, unknown>, store?: SessionStateStore) {
  const { publicJwk, sign } = await makeSigner();
  const f = fakeIssuer(publicJwk);
  const inner = f.fetch;
  f.login = () => jsonRes(200, { access_token: "a", refresh_token: "r", expires_in: 900, user: { id: "u" }, ...extra });
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/password/reset")) return jsonRes(200, { data: { status: "password_set", ...extra } });
    if (url.endsWith("/me/password")) return jsonRes(200, { data: { status: "updated", ...extra } });
    return inner(input, init);
  }) as typeof fetch;
  const realm = createRealm({
    realmId: REALM, apiKey: "rk_live_x", baseUrl: BASE, origin: "https://app.test", audience: AUD,
    fetch: fetchFn, clock: () => new Date(NOW * 1000),
    sessionStore: store ?? createMemorySessionStore({ now: () => Date.now() }),
  });
  const mw = realm.middleware({ exemptPaths: ["/health"] });
  // true when the app refuses a bearer carrying this sid
  const refused = async (sid: string) => {
    const tok = await sign(claimsFor(NOW, { sid, jti: sid }));
    const r = await drive(mw as never, { url: "/api/x", headers: { authorization: `Bearer ${tok}` } });
    return r.res.statusCode === 401 && !r.nextCalled;
  };
  return { realm, refused };
}

type E = Awaited<ReturnType<typeof env>>;
const calls: { name: string; do: (e: E) => Promise<string[] | undefined> }[] = [
  { name: "password_login_change_at_sign_in", do: async (e) =>
    (await e.realm.auth.passwordLogin({ identifier: "a@b.c", presented: "old", newPassword: "brand-new-pass-1" })).revokedSids },
  { name: "me_set_password", do: async (e) =>
    (await e.realm.me.setPassword({ userBearer: "ub", newPassword: "a-long-new-password" })).revokedSids },
  { name: "consume_password_reset", do: async (e) =>
    (await e.realm.auth.consumePasswordReset("tok", "a-long-new-password")).revokedSids },
];

for (const c of calls) {
  test(`RevokedSIDs WrittenToStoreAndTokenRefused: ${c.name}`, async () => {
    const e = await env({ revoked_sids: ["s1", "s2"] });
    assert.equal(await e.refused("s1"), false, "precondition: passes before the call");
    assert.equal(await e.refused("s2"), false);
    assert.deepEqual(await c.do(e), ["s1", "s2"]);
    assert.equal(await e.refused("s1"), true, "a token carrying a listed sid is refused after the call");
    assert.equal(await e.refused("s2"), true);
    assert.equal(await e.refused("s3"), false, "an unlisted sid keeps passing");
  });

  for (const [name, extra] of [
    ["empty", { revoked_sids: [] }],
    ["absent", {}],
    ["malformed", { revoked_sids: "s1" }],
    ["non-string members", { revoked_sids: [1, null, "", "s9"] }],
  ] as const) {
    test(`RevokedSIDs EmptyOrAbsentWritesNothing: ${c.name}/${name}`, async () => {
      const e = await env(extra as Record<string, unknown>);
      const got = await c.do(e);
      assert.deepEqual(got, name === "non-string members" ? ["s9"] : [], "an older issuer omits the field; not an error");
      assert.equal(await e.refused("s1"), false, "nothing listed, nothing written");
    });
  }

  test(`RevokedSIDs StoreWriteErrorIsNotReturned: ${c.name}`, async () => {
    const mem = createMemorySessionStore({ now: () => Date.now() });
    const failing: SessionStateStore = new Proxy(mem, {
      get(t, p) {
        if (p === "revokeSession") return () => Promise.reject(new Error("store down"));
        const v = (t as never)[p as never] as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const e = await env({ revoked_sids: ["s1"] }, failing);
    assert.deepEqual(await c.do(e), ["s1"], "store failure must not fail the call (logout parity)");
  });
}
