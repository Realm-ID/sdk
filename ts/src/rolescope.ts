/**
 * ADR-097 / ADR-100 D9 — the ROLE → SCOPE map.
 *
 * `ScopePolicy` (scope.ts) is the route → scope half: given a token, may this
 * request proceed. This module is the other half: given the roles a user holds
 * in YOUR product, what scopes should their token carry.
 *
 * Both maps live in the PARTNER'S repo. RealmID stores neither, and that is the
 * whole point of ADR-101 — adding a product role is a change in your codebase,
 * not a write into someone else's database with an owner-bound credential.
 *
 * ⚠️ "Role" here means YOUR role, not `realm_roles`. The two are unrelated and
 * easy to conflate. `realm_roles` is RealmID's own administrative vocabulary —
 * what a user may do TO REALMID. A scope governs what a user may do inside YOUR
 * product. RealmID never sees your roles and never sees your scopes.
 *
 * Where the output goes:
 *
 * ```ts
 * const scopes = scopesForRoles(myRoles, user.roles);
 * await realm.auth.login({
 *   ...,
 *   scope: scopes,           // what to request
 *   rolePermissions: scopes, // what the role actually confers
 * });
 * ```
 *
 * Passing the same list to both is the common case and is correct: `scope` is
 * the request and `rolePermissions` is the bound. They differ only when you
 * want to request LESS than the role confers. RealmID intersects
 * `rolePermissions` with any stored user-API-key `permissions_cap`, so the
 * minted token carries ONE effective set.
 */

import { isRfc6749ScopeToken } from "./scope.js";

/**
 * Maps YOUR role names to the scopes each confers.
 *
 * A plain record, not a class: it is configuration, it should be readable in a
 * diff, and the design intent is that it lives in your repo as data.
 */
export type RoleScopes = Record<string, string[]>;

/**
 * The union of scopes conferred by `roles`, sorted and de-duplicated.
 *
 * Sorted because the result is compared, logged and sent on the wire, and an
 * order that depends on object key iteration makes two identical grants look
 * different. De-duplicated because two roles commonly confer the same scope.
 *
 * FAIL-CLOSED AND SILENT: a role the map does not know contributes nothing.
 * A user holding an unmapped role gets fewer scopes and is refused at the gate;
 * throwing instead would lock people out of your product over a config gap.
 * Call {@link validateRoleScopes} at startup to catch the gap before it costs
 * anyone a scope.
 *
 * Returns `[]` when nothing is conferred. Note the asymmetry with the Go SDK,
 * which returns nil: JavaScript has no separate "absent" slice, so decide
 * explicitly whether to send `rolePermissions` at all — sending `[]` narrows to
 * nothing, omitting it does not narrow.
 */
export function scopesForRoles(map: RoleScopes, roles: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const role of roles) {
    for (const s of map[role] ?? []) {
      if (s !== "") seen.add(s);
    }
  }
  return [...seen].sort();
}

/** The role names the map knows, sorted. */
export function roleScopeNames(map: RoleScopes): string[] {
  return Object.keys(map).sort();
}

/** One problem found by {@link validateRoleScopes}. */
export interface RoleScopeConfigError {
  role: string;
  message: string;
}

/**
 * Reports configuration errors. Call it once at startup — a bad entry here
 * costs a user their authority at request time, far from the typo.
 *
 * Three refusals: an empty role name (which no token can match); a role mapped
 * to no scopes (almost always an unfinished entry — express "this role may do
 * nothing" by omitting the role, with a comment); and a scope that is not a
 * legal RFC 6749 §3.3 token, which the issuer refuses at mint. Catching the
 * last one here turns a login-time failure into a start-up failure.
 */
export function validateRoleScopes(map: RoleScopes): RoleScopeConfigError[] {
  const errs: RoleScopeConfigError[] = [];
  for (const role of roleScopeNames(map)) {
    if (role === "") {
      errs.push({ role, message: "role name is empty" });
      continue;
    }
    const scopes = map[role] ?? [];
    if (scopes.length === 0) {
      errs.push({ role, message: "maps to no scopes; omit the role instead" });
      continue;
    }
    for (const s of scopes) {
      if (!isRfc6749ScopeToken(s)) {
        errs.push({
          role,
          message: `maps to ${JSON.stringify(s)}, which is not a legal RFC 6749 scope token`,
        });
      }
    }
  }
  return errs;
}
