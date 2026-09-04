import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  AUTHORITY_STALE_SKEW_MS,
  MemAuthorityCache,
  type AuthorityCache,
} from "./authority.js";
import { createRealm } from "./realm.js";
import { RealmError, isTokenStale } from "./errors.js";
import { Verifier } from "./verifier.js";

// authority.test.ts — ADR-107, the TypeScript half.
//
// The hazard these tests are mostly about is NOT the demotion window. It is the
// refresh LOOP in C5: stamp `notBefore` from the partner's clock, compare it to
// an `iat` stamped by the issuer's, and two seconds of forward skew turns every
// freshly-minted token into a stale one — refresh, fail, refresh. D8 (stamp
// early) and D13 (honour a forced refresh at most once per token) are the two
// guards, and both are tested here.

const BASE_URL = "https://auth.test.example";
const REALM_ID = "01HXYZREALM";
const AUD = "example.com";

/* -------------------------------------------------- the cache (D3, D4, D6) */

test("MemAuthorityCache: stores a TIMESTAMP, not a flag", async () => {
  const now = 1_700_000_000_000;
  const c = new MemAuthorityCache(() => now);
  assert.equal(await c.staleSince("sub-1"), null);

  await c.markStale("sub-1", now - 30_000, now + 900_000);
  // D3: a boolean could not self-heal — it would reject the REFRESHED token
  // too, locking the user out for the entry's whole TTL and turning a demotion
  // into an outage.
  assert.equal(await c.staleSince("sub-1"), now - 30_000);
});

test("MemAuthorityCache: no entry is null, never epoch 0", async () => {
  const c = new MemAuthorityCache(() => 1_700_000_000_000);
  const got = await c.staleSince("never-marked");
  // Returning 0 here would read as "stale since 1970" — i.e. every token
  // rejected, forever — and a `!value` check would read it as "not stale".
  // Both are silent, and in opposite directions.
  assert.equal(got, null);
});

test("MemAuthorityCache: entry evicts lazily after its TTL (D6)", async () => {
  let now = 1_700_000_000_000;
  const c = new MemAuthorityCache(() => now);
  await c.markStale("sub-1", now, now + 900_000);
  now += 960_000;
  assert.equal(await c.staleSince("sub-1"), null);
  assert.equal(c.size(), 0);
});

test("MemAuthorityCache: the key is per-MEMBERSHIP (D4)", async () => {
  const now = 1_700_000_000_000;
  const c = new MemAuthorityCache(() => now);
  await c.markStale("sub-org-a", now, now + 900_000);
  // Demoting someone in org A must leave their org B token untouched. That
  // blast radius is the whole reason `sub` was chosen over an identity id.
  assert.equal(await c.staleSince("sub-org-b"), null);
});

/* ---------------------------------------- the notify method (D7, D11, D15) */

function realmWith(authority?: AuthorityCache, clock?: () => Date) {
  return createRealm({
    realmId: REALM_ID,
    apiKey: "rk_live_test",
    baseUrl: BASE_URL,
    audience: AUD,
    authority,
    clock,
  });
}

test("notifyAuthorityChanged: stamps the marker EARLY (D8)", async () => {
  const now = new Date("2026-04-01T00:00:00Z");
  const cache = new MemAuthorityCache(() => now.getTime());
  const realm = realmWith(cache, () => now);

  await realm.notifyAuthorityChanged({ subject: "sub-1", intent: "demoted" });

  const nb = await cache.staleSince("sub-1");
  assert.notEqual(nb, null);
  // D8: never bare `now`. Erring EARLY costs one harmless extra refresh; erring
  // LATE puts the marker in the ISSUER's future, which is the only way the C5
  // loop starts.
  assert.ok(nb! < now.getTime(), "marker is not before local now — D8's skew allowance is missing");
  assert.equal(now.getTime() - nb!, AUTHORITY_STALE_SKEW_MS);
});

test("notifyAuthorityChanged: intent is required and never inferred (D11)", async () => {
  const realm = realmWith(new MemAuthorityCache());
  for (const change of [
    { subject: "sub-1" },
    { subject: "sub-1", intent: "logged_out" },
    { intent: "promoted" },
  ]) {
    await assert.rejects(
      () => realm.notifyAuthorityChanged(change as never),
      (e: Error) => e instanceof RealmError,
      `expected rejection for ${JSON.stringify(change)}`,
    );
  }
});

test("notifyAuthorityChanged: no cache configured is an ERROR, not a no-op (D15)", async () => {
  const realm = realmWith(undefined);
  await assert.rejects(
    () => realm.notifyAuthorityChanged({ subject: "sub-1", intent: "demoted" }),
    (e: Error) =>
      e instanceof RealmError && /authority/i.test(e.message),
    "a silent no-op means a partner believes demotion is propagating while nothing is stored",
  );
});

test("the two caches are separate fields (D1/D2)", () => {
  const authority = new MemAuthorityCache();
  const realm = realmWith(authority);
  // Widening RevocationCache would break a partner's existing implementation —
  // and in TypeScript it breaks SILENTLY at runtime, where a duck-typed object
  // simply lacks the method and demotion never fires with nothing to observe.
  assert.equal(realm.authority, authority);
  assert.equal(realm.revocation, undefined);
});

/* ------------------------------------------ the verifier check (D3, D9, D10) */

async function mintKey(kid: string) {
  const kp = await globalThis.crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await globalThis.crypto.subtle.exportKey("jwk", kp.publicKey);
  const publicJwk = { kty: jwk.kty!, n: jwk.n!, e: jwk.e!, kid, alg: "RS256", use: "sig" };
  const b64 = (bytes: Uint8Array) => {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  };
  async function signToken(claims: Record<string, unknown>): Promise<string> {
    const enc = (o: unknown) => b64(new TextEncoder().encode(JSON.stringify(o)));
    const input = `${enc({ alg: "RS256", typ: "JWT", kid })}.${enc(claims)}`;
    const sig = await globalThis.crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" }, kp.privateKey, new TextEncoder().encode(input),
    );
    return `${input}.${b64(new Uint8Array(sig))}`;
  }
  return { publicJwk, signToken };
}

function jwksFetch(keys: object[]): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith(`/${REALM_ID}/.well-known/jwks.json`)) {
      return new Response(JSON.stringify({ keys }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

test("verify: a token minted before the change is token_stale (D10)", async () => {
  const { publicJwk, signToken } = await mintKey("kid-1");
  const now = new Date("2026-04-01T00:00:00Z");
  const sec = Math.floor(now.getTime() / 1000);
  const cache = new MemAuthorityCache(() => now.getTime());
  const v = new Verifier({
    baseUrl: BASE_URL, audience: AUD, fetch: jwksFetch([publicJwk]),
    now: () => now, authority: cache,
  });

  const token = await signToken({
    iss: `${BASE_URL}/${REALM_ID}`, sub: "user-1", aud: AUD,
    iat: sec - 600, exp: sec + 300,
  });
  // Pre-condition: it verifies before the change.
  assert.equal((await v.verify(token)).sub, "user-1");

  await cache.markStale("user-1", now.getTime() - 60_000, now.getTime() + 900_000);

  await assert.rejects(
    () => v.verify(token),
    (e: Error) => {
      // D10: distinct from `unauthorized`. Without it, a client that treats
      // every 401 as "sign the user out" signs people out on PROMOTION.
      assert.ok(isTokenStale(e), `want token_stale, got ${(e as RealmError).code}`);
      assert.equal((e as RealmError).httpStatus, 401);
      return true;
    },
  );
});

test("verify: the REFRESHED token passes the same marker (D3 self-heal)", async () => {
  const { publicJwk, signToken } = await mintKey("kid-1");
  const now = new Date("2026-04-01T00:00:00Z");
  const sec = Math.floor(now.getTime() / 1000);
  const cache = new MemAuthorityCache(() => now.getTime());
  await cache.markStale("user-1", now.getTime() - 30_000, now.getTime() + 900_000);

  const v = new Verifier({
    baseUrl: BASE_URL, audience: AUD, fetch: jwksFetch([publicJwk]),
    now: () => now, authority: cache,
  });
  const fresh = await signToken({
    iss: `${BASE_URL}/${REALM_ID}`, sub: "user-1", aud: AUD,
    iat: sec, exp: sec + 900,
  });
  // The single most important assertion in this file. If the refreshed token is
  // rejected by the marker that caused the refresh, that is an unbounded loop —
  // which ADR-107 C5 calls a worse outcome than the 900s window it closes.
  assert.equal((await v.verify(fresh)).sub, "user-1");
});

test("verify: a cache outage fails closed as unauthorized, NOT token_stale", async () => {
  const { publicJwk, signToken } = await mintKey("kid-1");
  const now = new Date("2026-04-01T00:00:00Z");
  const sec = Math.floor(now.getTime() / 1000);
  const broken: AuthorityCache = {
    markStale: async () => { throw new Error("backend down"); },
    staleSince: async () => { throw new Error("backend down"); },
  };
  const v = new Verifier({
    baseUrl: BASE_URL, audience: AUD, fetch: jwksFetch([publicJwk]),
    now: () => now, authority: broken,
  });
  const token = await signToken({
    iss: `${BASE_URL}/${REALM_ID}`, sub: "user-1", aud: AUD, iat: sec, exp: sec + 900,
  });
  await assert.rejects(() => v.verify(token), (e: Error) => {
    // Answering token_stale on an outage would tell every client to refresh at
    // once — C5's loop with an unrelated dependency as the trigger.
    assert.ok(!isTokenStale(e), "a cache outage answered token_stale");
    return e instanceof RealmError && e.code === "unauthorized";
  });
});

test("verify: no authority cache configured is a no-op", async () => {
  const { publicJwk, signToken } = await mintKey("kid-1");
  const now = new Date("2026-04-01T00:00:00Z");
  const sec = Math.floor(now.getTime() / 1000);
  const v = new Verifier({
    baseUrl: BASE_URL, audience: AUD, fetch: jwksFetch([publicJwk]), now: () => now,
  });
  const token = await signToken({
    iss: `${BASE_URL}/${REALM_ID}`, sub: "user-1", aud: AUD, iat: sec - 3600, exp: sec + 900,
  });
  assert.equal((await v.verify(token)).sub, "user-1");
});
