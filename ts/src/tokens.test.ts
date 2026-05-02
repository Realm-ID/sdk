import { test } from "node:test";
import assert from "node:assert/strict";
import { TokensClient, TokenRevokedError } from "./tokens.js";
import { RealmError } from "./errors.js";

/** Build an RS256-shaped JWT (header.payload.sig) with arbitrary claims.
 *  Signature is gibberish — `tokens` only base64-decodes the payload. */
function makeJwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown): string =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256", typ: "JWT" })}.${enc(claims)}.sig`;
}

test("markRevoked + isRevoked: happy path", () => {
  const now = 1_700_000_000_000;
  const c = new TokensClient(() => now);
  const tok = makeJwt({ jti: "abc", exp: Math.floor(now / 1000) + 900 });
  assert.equal(c.isRevoked(tok), false);
  c.markRevoked(tok);
  assert.equal(c.isRevoked(tok), true);
});

test("isRevoked: TTL expiry causes lazy eviction", () => {
  let now = 1_700_000_000_000;
  const c = new TokensClient(() => now);
  const tok = makeJwt({ jti: "abc", exp: Math.floor(now / 1000) + 60 });
  c.markRevoked(tok);
  assert.equal(c.size(), 1);
  now += 120 * 1000;
  assert.equal(c.isRevoked(tok), false);
  assert.equal(c.size(), 0);
});

test("markRevoked: no-op when jti missing", () => {
  const now = 1_700_000_000_000;
  const c = new TokensClient(() => now);
  const tok = makeJwt({ exp: Math.floor(now / 1000) + 900 });
  c.markRevoked(tok);
  assert.equal(c.size(), 0);
});

test("markRevoked: no-op when exp missing", () => {
  const c = new TokensClient(() => 1_700_000_000_000);
  const tok = makeJwt({ jti: "abc" });
  c.markRevoked(tok);
  assert.equal(c.size(), 0);
});

test("markRevoked: no-op when exp already past", () => {
  const now = 1_700_000_000_000;
  const c = new TokensClient(() => now);
  const tok = makeJwt({ jti: "abc", exp: Math.floor(now / 1000) - 60 });
  c.markRevoked(tok);
  assert.equal(c.size(), 0);
});

test("gateRequest: throws TokenRevokedError on cached jti", () => {
  const now = 1_700_000_000_000;
  const c = new TokensClient(() => now);
  const tok = makeJwt({ jti: "abc", exp: Math.floor(now / 1000) + 900 });
  c.markRevoked(tok);
  assert.throws(() => c.gateRequest(tok), (e: unknown) => {
    return e instanceof TokenRevokedError
      && e instanceof RealmError
      && e.code === "unauthorized"
      && (e.details as { revoked?: boolean })?.revoked === true;
  });
});

test("gateRequest: passes through when jti not cached", () => {
  const now = 1_700_000_000_000;
  const c = new TokensClient(() => now);
  const tok = makeJwt({ jti: "abc", exp: Math.floor(now / 1000) + 900 });
  // does not throw
  c.gateRequest(tok);
});

test("revokeOnLogout: caches even on network failure", async () => {
  const now = 1_700_000_000_000;
  const c = new TokensClient(() => now);
  const tok = makeJwt({ jti: "abc", exp: Math.floor(now / 1000) + 900 });
  const failingLogout = async () => {
    throw new Error("RI unreachable");
  };
  const wrapped = c.revokeOnLogout(failingLogout);
  await assert.rejects(() => wrapped(tok), /RI unreachable/);
  assert.equal(c.isRevoked(tok), true);
});

test("revokeOnLogout: caches on success", async () => {
  const now = 1_700_000_000_000;
  const c = new TokensClient(() => now);
  const tok = makeJwt({ jti: "abc", exp: Math.floor(now / 1000) + 900 });
  const ok = async () => ({ status: "ok" });
  const wrapped = c.revokeOnLogout(ok);
  const out = await wrapped(tok);
  assert.deepEqual(out, { status: "ok" });
  assert.equal(c.isRevoked(tok), true);
});

test("cache size doesn't grow under repeat marks of same jti", () => {
  const now = 1_700_000_000_000;
  const c = new TokensClient(() => now);
  const tok = makeJwt({ jti: "abc", exp: Math.floor(now / 1000) + 900 });
  for (let i = 0; i < 100; i++) c.markRevoked(tok);
  assert.equal(c.size(), 1);
});
