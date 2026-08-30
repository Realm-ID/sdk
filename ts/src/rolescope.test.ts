import assert from "node:assert/strict";
import test from "node:test";

import { scopesForRoles, roleScopeNames, validateRoleScopes, type RoleScopes } from "./rolescope.js";

const MAP: RoleScopes = {
  dispatcher: ["orders:read", "orders:assign"],
  accountant: ["invoices:read", "orders:read"],
  observer: ["orders:read"],
};

// The output goes on the wire and into rolePermissions, so it must be a SET —
// sorted and de-duplicated — not whatever order two objects happened to
// iterate in. Two identical grants that serialise differently are
// indistinguishable from two different grants in a log or a diff.
test("scopesForRoles unions, sorts and de-duplicates", () => {
  const want = ["invoices:read", "orders:assign", "orders:read"];
  assert.deepEqual(scopesForRoles(MAP, ["dispatcher", "accountant"]), want);
  // Role order must not change the result either.
  assert.deepEqual(scopesForRoles(MAP, ["accountant", "dispatcher"]), want);
});

// Fail-closed, and deliberately silent: a user holding a role the map does not
// know gets fewer scopes and is refused at the gate. Throwing instead would
// lock people out of the product over a config gap, which is what
// validateRoleScopes exists to catch at startup.
test("an unknown role contributes nothing", () => {
  assert.deepEqual(scopesForRoles({ known: ["a:read"] }, ["ghost"]), []);
  assert.deepEqual(scopesForRoles({ known: ["a:read"] }, ["known", "ghost"]), ["a:read"]);
  assert.deepEqual(scopesForRoles(MAP, []), []);
  assert.deepEqual(scopesForRoles({}, ["dispatcher"]), []);
});

// Each of these is a config error whose symptom appears at request time, far
// from the typo.
test("validateRoleScopes catches the gaps that cost authority", () => {
  assert.deepEqual(validateRoleScopes({ ok: ["orders:read"] }), []);

  const empty = validateRoleScopes({ "": ["a:read"] });
  assert.equal(empty.length, 1);
  assert.match(empty[0].message, /role name is empty/);

  const idle = validateRoleScopes({ idle: [] });
  assert.equal(idle.length, 1);
  assert.match(idle[0].message, /maps to no scopes/);
  assert.equal(idle[0].role, "idle");

  const bad = validateRoleScopes({ bad: ["has space"] });
  assert.equal(bad.length, 1);
  assert.match(bad[0].message, /not a legal RFC 6749 scope token/);
});

// Used for a startup log line and for asserting coverage in a partner's own
// tests, so it must not depend on key insertion order.
test("roleScopeNames is sorted", () => {
  assert.deepEqual(roleScopeNames({ zulu: ["a"], alpha: ["b"], mike: ["c"] }), [
    "alpha",
    "mike",
    "zulu",
  ]);
  assert.deepEqual(roleScopeNames({}), []);
});
