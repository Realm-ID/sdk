import { test } from "node:test";
import { strict as assert } from "node:assert";

import { capAllows, isUserApiKeyRevoked, UserApiKeysClient } from "./user-api-keys.js";
import type { UserApiKeyWrite } from "./user-api-keys.js";
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
  //
  // ⚠️ ADR-100 made this a state the SERVER CAN NO LONGER PRODUCE: `{}` is not a
  // storable cap, and an empty intersection at mint is a 403 rather than an
  // empty claim. This assertion is deliberately kept anyway. It is not dead
  // coverage — it pins the behaviour for a claim that arrives GARBLED or
  // hostile off the wire, where "I am capped, to something unreadable" must
  // still read as "to nothing". We no longer emit the state; we still deny on
  // it. Do not delete this on the grounds that the issuer cannot reach it.
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

// --- ADR-100: the write body ------------------------------------------------

type Captured = { method: string; path: string; body?: unknown };

function fakeHttp(seen: Captured[], resp: unknown = { id: "k1" }) {
  return {
    request: async (req: Captured) => {
      seen.push(req);
      return resp;
    },
  } as unknown as ConstructorParameters<typeof UserApiKeysClient>[0];
}

test("create ALWAYS sends uncapped, including when it is false", async () => {
  const seen: Captured[] = [];
  const c = new UserApiKeysClient(fakeHttp(seen));

  await c.create("t1", "u1", { label: "ci", uncapped: false, permissions_cap: ["a"] });
  assert.deepEqual(seen[0]!.body, {
    label: "ci",
    uncapped: false,
    permissions_cap: ["a"],
  });

  // The whole point of ADR-100. `false` is the value an `omitempty`-shaped
  // serialiser drops, and dropping it here would put the pre-ADR-100 wire shape
  // — a body with no authority statement — back on the wire from inside the SDK
  // that exists to prevent it. A missing `uncapped` is a 400 at the server, so
  // this failing would break every capped mint, loudly. Assert it anyway: the
  // failure mode being loud is a property of TODAY's server, not of the SDK.
  assert.ok(Object.prototype.hasOwnProperty.call(seen[0]!.body, "uncapped"));

  await c.create("t1", "u1", { label: "wide", uncapped: true });
  assert.deepEqual(seen[1]!.body, { label: "wide", uncapped: true });
});

test("create coerces a smuggled non-boolean uncapped rather than passing it through", async () => {
  const seen: Captured[] = [];
  const c = new UserApiKeysClient(fakeHttp(seen));
  // A plain-JS caller with no compiler. `null` passed through would serialise as
  // JSON null, which is the "absent authority" shape again.
  await c.create("t1", "u1", { label: "x", uncapped: null } as unknown as UserApiKeyWrite);
  assert.equal((seen[0]!.body as { uncapped: unknown }).uncapped, false);
});

test("update PUTs the same write body to the key's own path", async () => {
  const seen: Captured[] = [];
  const c = new UserApiKeysClient(fakeHttp(seen));

  await c.update("t1", "u1", "k9", { label: "ci", uncapped: false, permissions_cap: ["a"] });

  assert.equal(seen[0]!.method, "PUT");
  assert.equal(seen[0]!.path, "/tenants/t1/users/u1/user-api-keys/k9");
  // Byte-identical to what create would have sent for the same input: one write
  // schema, serialised in one place, so the pair cannot drift into a PATCH.
  assert.deepEqual(seen[0]!.body, { label: "ci", uncapped: false, permissions_cap: ["a"] });
});

test("update path-escapes the key id", async () => {
  const seen: Captured[] = [];
  const c = new UserApiKeysClient(fakeHttp(seen));
  await c.update("t1", "u1", "../evil", { label: "x", uncapped: true });
  assert.ok(!seen[0]!.path.includes("../"), `path traversal reached the URL: ${seen[0]!.path}`);
});
