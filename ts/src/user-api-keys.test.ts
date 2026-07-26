import { test } from "node:test";
import { strict as assert } from "node:assert";

import { capAllows, isUserApiKeyRevoked } from "./user-api-keys.js";
import type { Claims } from "./claims.js";

// capAllows is the one helper in this SDK whose SIGNATURE is a security control
// (SPEC §6.6.2): the live-permission resolver is a required third argument, so
// the insecure one-operand form — "does the cap list this permission?" — cannot
// be written through this API at all.

function claimsWithCap(cap: unknown): Claims {
  return {
    iss: "https://auth.realmid.dev/r1",
    sub: "u1",
    aud: "realmid:plt_x",
    exp: 9999999999,
    iat: 1,
    permissions_cap: cap,
  } as Claims;
}

const uncapped: Claims = {
  iss: "https://auth.realmid.dev/r1",
  sub: "u1",
  aud: "realmid:plt_x",
  exp: 9999999999,
  iat: 1,
};

const live =
  (...perms: string[]) =>
  () =>
    perms;

test("capAllows requires BOTH the cap and the live set", async () => {
  assert.equal(
    await capAllows(claimsWithCap(["reports:read"]), "reports:read", live("reports:read", "users:read")),
    true,
  );
  // In the cap but no longer live: the holder's role shrank. This is the case the
  // whole design exists for — a stale cap must not resurrect lost authority.
  assert.equal(
    await capAllows(claimsWithCap(["users:manage"]), "users:manage", live("reports:read")),
    false,
  );
  // Live but outside the cap: the key is narrower than the human.
  assert.equal(
    await capAllows(claimsWithCap(["reports:read"]), "users:manage", live("users:manage")),
    false,
  );
});

test("capAllows fails closed", async () => {
  const claims = claimsWithCap(["reports:read"]);
  // A throwing resolver means the live operand is unknown, and the only safe
  // reading of an unknown intersection is empty.
  assert.equal(
    await capAllows(claims, "reports:read", () => {
      throw new Error("store down");
    }),
    false,
  );
  assert.equal(
    await capAllows(claims, "reports:read", async () => {
      throw new Error("store down");
    }),
    false,
  );
  // Missing resolver — also the shape a caller would reach for if they wanted the
  // one-operand version.
  assert.equal(
    await capAllows(claims, "reports:read", undefined as unknown as () => string[]),
    false,
  );
  assert.equal(await capAllows(null, "reports:read", live("reports:read")), false);
  assert.equal(await capAllows(claims, "", live("reports:read")), false);
});

test("capAllows distinguishes an ABSENT cap from a PRESENT-but-empty one", async () => {
  // ABSENT = not key-derived = uncapped. Only the live set governs, so an
  // ordinary session keeps working through this helper.
  assert.equal(await capAllows(uncapped, "users:manage", live("users:manage")), true);
  assert.equal(await capAllows(uncapped, "users:manage", live("reports:read")), false);

  // PRESENT but empty = capped to nothing = deny everything. Conflating this with
  // "absent" would turn every empty-cap key into a FULL-AUTHORITY one, which is
  // the worst direction for the bug to go.
  assert.equal(await capAllows(claimsWithCap([]), "users:manage", live("users:manage")), false);
});

test("capAllows treats a malformed cap as capped to nothing", async () => {
  for (const bad of ["reports:read", 42, { reports: "read" }, null]) {
    assert.equal(
      await capAllows(claimsWithCap(bad), "reports:read", live("reports:read")),
      false,
      `malformed cap ${JSON.stringify(bad)} must deny`,
    );
  }
  // A mixed array keeps the entries it understood: dropping junk only narrows,
  // which is always safe.
  assert.equal(
    await capAllows(claimsWithCap(["reports:read", 7]), "reports:read", live("reports:read")),
    true,
  );
});

test("capAllows never expands wildcards or applies hierarchy", async () => {
  // RealmID does not pattern-match these strings, and neither may the SDK — a
  // partner who saw "users:*" work here would build a mental model the server
  // does not share.
  assert.equal(await capAllows(claimsWithCap(["users:*"]), "users:read", live("users:read")), false);
  assert.equal(await capAllows(claimsWithCap(["users"]), "users:read", live("users:read")), false);
  assert.equal(
    await capAllows(claimsWithCap(["Users:Read"]), "users:read", live("users:read")),
    false,
  );
});

test("capAllows awaits an async resolver", async () => {
  assert.equal(
    await capAllows(claimsWithCap(["reports:read"]), "reports:read", async () => ["reports:read"]),
    true,
  );
});

test("isUserApiKeyRevoked keys off revoked_at", () => {
  assert.equal(isUserApiKeyRevoked({ id: "k1" }), false);
  assert.equal(isUserApiKeyRevoked({ id: "k2", revoked_at: null }), false);
  assert.equal(isUserApiKeyRevoked({ id: "k3", revoked_at: 1000 }), true);
});
