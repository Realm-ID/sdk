import { test } from "node:test";
import { strict as assert } from "node:assert";
import { RealmError } from "./errors.js";
import { createSplitRealm, type PreviousKey } from "./split.js";
import { SplitKey, FakeIssuer, MemShares, jsonReply, userClaims, b64big, TEST_REALM, BASE } from "./split-testutil.test.js";

// SPEC14_4_trust: a split verifier trusts the bundle's public keys only, never RI's JWKS.

const jwksPath = `/${TEST_REALM}/.well-known/jwks.json`;

test("trust: a split realm without a share source fails to construct (R4 mandatory pinning)", async () => {
  const f = new FakeIssuer();
  const k = await SplitKey.make("split-1");
  // control: the same config WITH a source constructs
  createSplitRealm({ ...f.cfg(), shareSource: new MemShares(k.bundle(TEST_REALM)) });
  assert.throws(
    () => createSplitRealm({ ...f.cfg() } as never),
    (e: unknown) => e instanceof RealmError && e.code === "invalid_config",
  );
});

test("trust: a bundle key verifies and RI's JWKS is never fetched", async () => {
  const k = await SplitKey.make("split-1");
  const f = new FakeIssuer();
  f.on(jwksPath, () => jsonReply(200, { keys: [] }));
  const realm = createSplitRealm({ ...f.cfg(), shareSource: new MemShares(k.bundle(TEST_REALM)) });
  await realm.verify(await k.fullJWT(userClaims(f.issuer)));
  assert.equal(f.reqs(jwksPath).length, 0, "split verifier fetched RI's JWKS");
});

test("trust: a kid RI publishes but the bundle does not pin is refused as unpinned_kid", async () => {
  const bundleKey = await SplitKey.make("split-1");
  const riKey = await SplitKey.make("ri-full-1");
  const f = new FakeIssuer();
  f.on(jwksPath, () => jsonReply(200, { keys: [{ kty: "RSA", kid: "ri-full-1", alg: "RS256", use: "sig", n: b64big(riKey.n), e: "AQAB" }] }));
  const realm = createSplitRealm({ ...f.cfg(), shareSource: new MemShares(bundleKey.bundle(TEST_REALM)) });
  await assert.rejects(realm.verify(await riKey.fullJWT(userClaims(f.issuer))),
    (e: unknown) => e instanceof RealmError && (e.code as string) === "unpinned_kid");
});

test("trust: a previous key is trusted until trust_until, unpinned_kid after (injected clock)", async () => {
  const cur = await SplitKey.make("split-2");
  const old = await SplitKey.make("split-1");
  const f = new FakeIssuer();
  const t0 = Math.floor(Date.now() / 1000);
  const b = cur.bundle(TEST_REALM);
  const prev: PreviousKey = { kid: "split-1", n: b64big(old.n), e: "AQAB", trust_until: t0 + 3600 };
  b.previous = [prev];
  let nowSec = t0;
  const realm = createSplitRealm({ ...f.cfg((c) => { c.clock = () => new Date(nowSec * 1000); }), shareSource: new MemShares(b) });
  await realm.verify(await old.fullJWT(userClaims(f.issuer, nowSec)));
  nowSec = t0 + 7200;
  await assert.rejects(realm.verify(await old.fullJWT(userClaims(f.issuer, nowSec))),
    (e: unknown) => e instanceof RealmError && (e.code as string) === "unpinned_kid");
  void BASE;
});
