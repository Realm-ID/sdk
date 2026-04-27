import { test } from "node:test";
import assert from "node:assert/strict";
import { MemRevocationCache } from "./revocation.js";

test("MemRevocationCache: empty cache reports not revoked", async () => {
  const c = new MemRevocationCache();
  assert.equal(await c.isRevoked("any"), false);
});

test("MemRevocationCache: revoked jti reports true within TTL", async () => {
  const now = 1_700_000_000_000;
  const c = new MemRevocationCache(() => now);
  await c.revoke("jti-1", now + 15 * 60 * 1000);
  assert.equal(await c.isRevoked("jti-1"), true);
});

test("MemRevocationCache: expired entry evicts lazily", async () => {
  let now = 1_700_000_000_000;
  const c = new MemRevocationCache(() => now);
  await c.revoke("jti-1", now + 5 * 60 * 1000);
  now += 10 * 60 * 1000;
  assert.equal(await c.isRevoked("jti-1"), false);
  assert.equal(c.size(), 0);
});

test("MemRevocationCache: empty jti is no-op", async () => {
  const c = new MemRevocationCache();
  await c.revoke("", Date.now());
  assert.equal(await c.isRevoked(""), false);
  assert.equal(c.size(), 0);
});
