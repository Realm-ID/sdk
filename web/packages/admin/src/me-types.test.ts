import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { MeMembership } from "./types.js";

/**
 * A COMPILE-TIME pin. `MeMembership` is a type — nothing at runtime can notice
 * a field going missing — so what guards `realm_id` here is that these object
 * literals must still typecheck. Rename or delete the field and `npm run
 * typecheck` fails on this file.
 *
 * That only works because `typecheck` runs tsconfig.test.json as well: the
 * package's build tsconfig EXCLUDES `src/**\/*.test.ts`, and `node --test
 * --import tsx` strips types without checking them, so before that second pass
 * existed a type assertion in a test file was checked by NOTHING. Verified by
 * mutation, not by assumption.
 *
 * Two subjects, the pair the field exists to separate: an ordinary org
 * (realm_id == platform_id) and an admin tenant, where platform_id is the realm
 * ADMINISTERED and realm_id is the base realm the tenant LIVES IN (ADR-015).
 */
const org: MeMembership = {
  tenant_id: "t-org",
  platform_id: "realm-partner",
  realm_id: "realm-partner",
  display_name: "Partner Org",
  role: "member",
};

const adminTenant: MeMembership = {
  tenant_id: "t-admin",
  platform_id: "realm-partner",
  realm_id: "realm-base",
  display_name: "Partner Admin",
  role: "owner",
};

// A membership as it arrives through a BFF that has not declared the field: it
// is DROPPED in that BFF's re-encode, so the type must tolerate its absence.
const viaOlderBff: MeMembership = {
  tenant_id: "t",
  platform_id: "p",
  display_name: "d",
  role: "member",
};

describe("MeMembership.realm_id", () => {
  it("equals platform_id for an org and differs for an admin tenant", () => {
    assert.equal(org.realm_id, org.platform_id);
    assert.notEqual(adminTenant.realm_id, adminTenant.platform_id);
  });

  it("is optional — absent means unknown, never 'no realm'", () => {
    assert.equal(viaOlderBff.realm_id, undefined);
  });
});
