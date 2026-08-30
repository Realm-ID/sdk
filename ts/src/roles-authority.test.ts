import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  confersAuthority,
  isRoleAssignableTo,
  isRoleSeatable,
  rolesAssignableTo,
  NON_ASSIGNABLE_ROLES,
  type AssignableRole,
} from "./roles.js";

// ADR-101 D6 + ADR-081. The issuer is authoritative; see roles-drift.test.ts
// for the check that these predicates still agree with it. This file is the
// BEHAVIOUR half: what each predicate answers for a given role.

function role(over: Partial<AssignableRole> = {}): AssignableRole {
  return { name: "member", permissions: [], assignable_to: ["human", "service"], ...over };
}

// ---- confersAuthority (ADR-101 D6) ----

test("confersAuthority: a read-only grant set confers nothing", () => {
  assert.equal(confersAuthority({ permissions: ["users:read", "audit:read"] }), false);
});

test("confersAuthority: any non-read action confers", () => {
  assert.equal(confersAuthority({ permissions: ["users:read", "users:manage"] }), true);
  assert.equal(confersAuthority({ permissions: ["signing_keys:rotate"] }), true);
  assert.equal(confersAuthority({ permissions: ["sessions:revoke"] }), true);
  assert.equal(confersAuthority({ permissions: ["platform:config"] }), true);
});

test("confersAuthority: empty / absent / null permissions confer nothing", () => {
  assert.equal(confersAuthority({ permissions: [] }), false);
  assert.equal(confersAuthority({}), false);
  assert.equal(confersAuthority({ permissions: null }), false);
});

test("confersAuthority: a malformed entry FAILS CLOSED", () => {
  // No colon: unparseable, so it must not be read as harmless.
  assert.equal(confersAuthority({ permissions: ["wat"] }), true);
  assert.equal(confersAuthority({ permissions: ["users:read", "wat"] }), true);
  // An empty string is not a grant at all — it is a blank, not an unknown.
  assert.equal(confersAuthority({ permissions: [""] }), false);
});

test("confersAuthority: derived from the grants, NEVER from the name", () => {
  assert.equal(confersAuthority({ permissions: [] }), false); // a role called admin with nothing
  assert.equal(confersAuthority({ permissions: ["sessions:revoke"] }), true); // one called reporting
});

test("confersAuthority: with a served catalog, an UNKNOWN key fails closed", () => {
  const catalog = [
    { key: "users:read", resource: "users", action: "read", label: "View users" },
    { key: "users:manage", resource: "users", action: "manage", label: "Manage users" },
  ];
  // `orders:read` parses as a read but is not in the catalog. The issuer's
  // IsMutatingPermission answers TRUE for an unknown key; with the catalog in
  // hand the SDK must answer the same.
  assert.equal(confersAuthority({ permissions: ["orders:read"] }, { catalog }), true);
  assert.equal(confersAuthority({ permissions: ["users:read"] }, { catalog }), false);
  assert.equal(confersAuthority({ permissions: ["users:manage"] }, { catalog }), true);
  assert.equal(confersAuthority({ permissions: [] }, { catalog }), false);
});

// ---- isRoleAssignableTo (ADR-081 §2.4, mirrors requireRoleAssignableToKind) ----

test("isRoleAssignableTo: assignable_to gates the kind", () => {
  assert.equal(isRoleAssignableTo(role({ assignable_to: ["human"] }), "human"), true);
  assert.equal(isRoleAssignableTo(role({ assignable_to: ["human"] }), "service"), false);
  assert.equal(isRoleAssignableTo(role({ assignable_to: ["service"] }), "service"), true);
  assert.equal(isRoleAssignableTo(role({ assignable_to: ["service"] }), "human"), false);
});

test("isRoleAssignableTo: EMPTY or ABSENT assignable_to means ANY (read fails open)", () => {
  assert.equal(isRoleAssignableTo(role({ assignable_to: [] }), "service"), true);
  assert.equal(isRoleAssignableTo({ name: "legacy" }, "service"), true);
  assert.equal(isRoleAssignableTo({ name: "legacy" }, "human"), true);
});

test("isRoleAssignableTo: the human-only floor blocks a service principal", () => {
  for (const p of ["signing_keys:rotate", "domains:manage", "platform:config", "federation:manage"]) {
    const r = role({ name: "custom", permissions: [p] });
    assert.equal(isRoleAssignableTo(r, "service"), false, `${p} must block a service principal`);
    assert.equal(isRoleAssignableTo(r, "human"), true, `${p} must not block a human`);
  }
});

test("isRoleAssignableTo: ADR-091 exempts is_system roles from the human-only floor", () => {
  // platform_api is the realm's machine identity and D3 grants it
  // platform:config deliberately. Without the exemption the bot role would be
  // unassignable to the very bot it exists for.
  const bot = role({ name: "platform_api", permissions: ["platform:config"], assignable_to: ["service"], is_system: true });
  assert.equal(isRoleAssignableTo(bot, "service"), true);
  const partnerAuthored = role({ name: "ops", permissions: ["platform:config"], assignable_to: ["service"], is_system: false });
  assert.equal(isRoleAssignableTo(partnerAuthored, "service"), false);
});

test("isRoleAssignableTo: NO per-role MFA floor (ADR-101 retired required_mfa_methods)", () => {
  // A stale server that still emits the field must not change the answer.
  const r = { ...role({ assignable_to: ["service"] }), required_mfa_methods: ["totp"] };
  assert.equal(isRoleAssignableTo(r, "service"), true);
});

test("isRoleAssignableTo does NOT filter owner/platform_api/disabled — that is isRoleSeatable", () => {
  assert.equal(isRoleAssignableTo(role({ name: "owner", assignable_to: ["human"] }), "human"), true);
  assert.equal(isRoleAssignableTo(role({ disabled: true }), "human"), true);
});

// ---- isRoleSeatable (the picker predicate) ----

test("isRoleSeatable: excludes the non-assignable names on BOTH kinds", () => {
  // realmrole.NonAssignableRoles. All three are held by something other than a
  // role write: `owner` moves via the ADR-076 ownership pointer, `platform_api`
  // backs the API-key bot (ADR-041), and `platform_mgmt_api` is the ONLY
  // identity permitted to mint platform_api's key (ADR-091 D3) — a human
  // holding it is a credential-issuance path outside the owner pointer, which
  // is exactly what ADR-101 D6 closes.
  for (const name of ["owner", "platform_api", "platform_mgmt_api"]) {
    assert.equal(isRoleSeatable(role({ name, assignable_to: ["human"] }), "human"), false, name);
    assert.equal(
      isRoleSeatable(role({ name, assignable_to: ["service"], is_system: true }), "service"),
      false,
      name,
    );
  }
});

test("NON_ASSIGNABLE_ROLES is exported and is exactly the issuer's set", () => {
  assert.deepEqual([...NON_ASSIGNABLE_ROLES].sort(), ["owner", "platform_api", "platform_mgmt_api"]);
});

test("isRoleAssignableTo does NOT apply the non-assignable set — that is the server predicate", () => {
  // The issuer refuses these on the specific endpoints, not inside
  // requireRoleAssignableToKind. Keeping the mirror faithful is what lets the
  // drift gate compare it against anything.
  assert.equal(isRoleAssignableTo(role({ name: "platform_mgmt_api", assignable_to: ["human"] }), "human"), true);
});

test("isRoleSeatable: excludes a disabled role", () => {
  assert.equal(isRoleSeatable(role({ name: "support", disabled: true }), "human"), false);
  assert.equal(isRoleSeatable(role({ name: "support", disabled: false }), "human"), true);
});

test("isRoleSeatable: otherwise defers to isRoleAssignableTo", () => {
  assert.equal(isRoleSeatable(role({ name: "ops", permissions: ["domains:manage"] }), "service"), false);
  assert.equal(isRoleSeatable(role({ name: "ops", permissions: ["domains:manage"] }), "human"), true);
});

test("rolesAssignableTo filters a catalog with isRoleSeatable and preserves order", () => {
  const roles: AssignableRole[] = [
    role({ name: "owner", assignable_to: ["human"] }),
    role({ name: "admin", permissions: ["users:manage"] }),
    role({ name: "member" }),
    role({ name: "platform_api", assignable_to: ["service"], is_system: true }),
    role({ name: "platform_mgmt_api", assignable_to: ["service"], is_system: true }),
    role({ name: "gone", disabled: true }),
  ];
  assert.deepEqual(rolesAssignableTo(roles, "human").map((r) => r.name), ["admin", "member"]);
  assert.deepEqual(rolesAssignableTo(roles, "service").map((r) => r.name), ["admin", "member"]);
});
