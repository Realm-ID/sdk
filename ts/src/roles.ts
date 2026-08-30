/**
 * Realm-defined custom roles — ADR-040.
 *
 * Each realm owns a `realm_roles` catalog. `owner` and `member` are the
 * only system roles; everything else is partner-defined per realm. Use
 * the named constants when you want autocomplete on the two
 * load-bearing names; everywhere else `role` is just `string` (so a
 * partner that declares `salesman` or `dispatch` can pass that name
 * straight through).
 */

import type { HttpClient } from "./http.js";

/** The single load-bearing system role (ADR-040 §Decision). */
export const OWNER = "owner";
/** The neutral default; no special server-side gating (ADR-040 §Decision). */
export const MEMBER = "member";

/** Free-form role name. Stays a `string` — see ADR-040 decision §3. */
export type Role = string;

/**
 * The `users.kind` vocabulary a role's `assignable_to` is drawn from
 * (ADR-071 kinds, ADR-081 typing). Closed server-side: an unknown value is a
 * 400 `unknown_principal_kind`, so a union beats `string[]` here — a typo
 * fails at compile time rather than at request time.
 */
export type PrincipalKind = "human" | "service";

export interface RoleObject {
  id: string;
  name: string;
  display_name?: string;
  permissions: string[];
  /*
   * `required_mfa_methods` (ADR-075) and `can_invite_roles` (ADR-076 WP4) were
   * REMOVED from this shape by ADR-101, along with the columns behind them.
   * Zero realms ever configured an MFA floor, and the invitation scope bounded
   * one of four seating paths while ADR-101 D6 now bounds all four.
   */
  /**
   * ADR-081 principal typing — the `users.kind` values that may hold this
   * role. Since § Amendment 2 the server never stores this empty, so an empty
   * array means the response came from an issuer older than v0.57.0, where it
   * meant ANY. Treat it as ANY (read fails open; the server enforces on write).
   */
  assignable_to: PrincipalKind[];
  /**
   * ADR-081 §2.5 — set ONLY on the `update()` response of a patch that
   * narrowed `assignable_to` so humans may no longer hold the role: its human
   * holders were reassigned in the same transaction rather than stranded.
   * Absent on every other response.
   */
  migrated_holders?: number;
  /** The role those holders were migrated to. Present only with the count. */
  migrated_holders_to?: string;
  is_system: boolean;
  /**
   * A disabled role stays in the catalog but is hidden from the roles
   * surface and rejected as an invitation target. Toggle with
   * `disable()` / `enable()`. Absent on older servers (treat as false).
   */
  disabled?: boolean;
  /** Unix seconds the role was disabled; omitted when active. */
  disabled_at?: number;
  created_at: number;
  updated_at: number;
  [k: string]: unknown;
}

export interface RoleListPage {
  items: RoleObject[];
  next_cursor: string | null;
  total?: number;
}

/**
 * One entry in the fixed ADR-074 permission catalog, as served by
 * `GET /platforms/{id}/permissions`. These gate RI *admin-console* operations
 * for the platform — not the partner's own product RBAC.
 *
 * The catalog is a SERVED contract, which is why its type lives here and the
 * list does not: fetch it with `roles.listPermissions()` rather than pinning a
 * copy. `action` is the half `confersAuthority` turns on — anything but `read`
 * changes something.
 */
export interface CatalogPermission {
  key: string;
  resource: string;
  action: string;
  label: string;
}

/** @deprecated Use {@link CatalogPermission}; same shape, clearer name. */
export type Permission = CatalogPermission;

export interface RoleListOpts {
  cursor?: string;
  limit?: number;
  /**
   * Include system roles the server hides by default (currently
   * `platform_api`). `owner`/`member` are always returned. Maps to
   * `?include_system=true`.
   */
  includeSystem?: boolean;
}

export interface RoleCreate {
  name: string;
  displayName?: string;
  permissions?: string[];
  /**
   * ADR-081 — which principal kinds may hold the role. Omit the key and the
   * server defaults to BOTH kinds (that is not an error; the field is younger
   * than its clients). An explicit `[]` is a 400 `assignable_to_required` —
   * § Amendment 2 removed "unconstrained" as a storable state.
   */
  assignableTo?: PrincipalKind[];
}

export interface RolePatch {
  displayName?: string;
  permissions?: string[];
  /**
   * Overwrites the ADR-081 principal-kind constraint when provided; omit to
   * leave it untouched. Unlike its siblings there is NO clear — `[]` is a 400
   * `assignable_to_required`; name the kinds instead.
   *
   * Narrowing this so humans may no longer hold the role MIGRATES its existing
   * human holders, in the same transaction, to the realm's default invitation
   * role (else `member`); the response then carries `migrated_holders` +
   * `migrated_holders_to`.
   */
  assignableTo?: PrincipalKind[];
}

export class RolesClient {
  constructor(
    private readonly http: HttpClient,
    private readonly realmId: string,
  ) {}

  /**
   * GET /platforms/{id}/roles. Returns one page in the locked SPEC §7
   * envelope shape (`{items, next_cursor, total?}`). Unlike the typed
   * iterators on `realm.tenants` etc., this surface returns the raw
   * envelope so callers can drive their own paging UI directly.
   */
  async list(opts?: RoleListOpts): Promise<RoleListPage> {
    const raw = await this.http.request<unknown>({
      method: "GET",
      path: `/platforms/${encodeURIComponent(this.realmId)}/roles`,
      query: {
        cursor: opts?.cursor,
        limit: opts?.limit,
        include_system: opts?.includeSystem ? "true" : undefined,
      },
    });
    return normalizePage(raw);
  }

  async create(body: RoleCreate): Promise<RoleObject> {
    const wire: Record<string, unknown> = { name: body.name };
    if (body.displayName !== undefined) wire["display_name"] = body.displayName;
    if (body.permissions !== undefined) wire["permissions"] = body.permissions;
    if (body.assignableTo !== undefined) wire["assignable_to"] = body.assignableTo;
    return this.http.request<RoleObject>({
      method: "POST",
      path: `/platforms/${encodeURIComponent(this.realmId)}/roles`,
      body: wire,
    });
  }

  async update(roleId: string, patch: RolePatch): Promise<RoleObject> {
    const wire: Record<string, unknown> = {};
    if (patch.displayName !== undefined) wire["display_name"] = patch.displayName;
    if (patch.permissions !== undefined) wire["permissions"] = patch.permissions;
    if (patch.assignableTo !== undefined) wire["assignable_to"] = patch.assignableTo;
    return this.http.request<RoleObject>({
      method: "PATCH",
      path: `/platforms/${encodeURIComponent(this.realmId)}/roles/${encodeURIComponent(roleId)}`,
      body: wire,
    });
  }

  /**
   * DELETE /platforms/{id}/roles/{roleId}. Pass `migrateTo` (ADR-074/Phase 3)
   * to reassign every holder of this role to another role server-side (one
   * transaction) instead of getting a 409 `role_in_use`.
   */
  async delete(
    roleId: string,
    opts?: { migrateTo?: string },
  ): Promise<{ status: "deleted" }> {
    return this.http.request<{ status: "deleted" }>({
      method: "DELETE",
      path: `/platforms/${encodeURIComponent(this.realmId)}/roles/${encodeURIComponent(roleId)}`,
      query: opts?.migrateTo ? { migrate_to: opts.migrateTo } : undefined,
    });
  }

  async rename(roleId: string, opts: { to: string }): Promise<RoleObject> {
    return this.http.request<RoleObject>({
      method: "POST",
      path: `/platforms/${encodeURIComponent(this.realmId)}/roles/${encodeURIComponent(roleId)}/rename`,
      body: { to: opts.to },
    });
  }

  /**
   * Soft-disable a custom role (POST …/roles/{id}/disable). The role stays
   * in the catalog but is hidden and no longer assignable. The server
   * rejects disabling a protected role (`owner`/`platform_api`), the realm's
   * current default invitation role, or the last remaining active role.
   */
  async disable(roleId: string): Promise<RoleObject> {
    return this.http.request<RoleObject>({
      method: "POST",
      path: `/platforms/${encodeURIComponent(this.realmId)}/roles/${encodeURIComponent(roleId)}/disable`,
    });
  }

  /** Re-enable a previously disabled role (POST …/roles/{id}/enable). */
  async enable(roleId: string): Promise<RoleObject> {
    return this.http.request<RoleObject>({
      method: "POST",
      path: `/platforms/${encodeURIComponent(this.realmId)}/roles/${encodeURIComponent(roleId)}/enable`,
    });
  }

  /**
   * GET /platforms/{id}/permissions — the fixed catalog of grantable
   * permissions (ADR-074). Drives a grouped checklist in the admin UI so it
   * never hardcodes the list. Served live (not a static const) so the UI can't
   * drift from the server's catalog.
   */
  async listPermissions(): Promise<Permission[]> {
    const raw = await this.http.request<{ permissions?: Permission[] }>({
      method: "GET",
      path: `/platforms/${encodeURIComponent(this.realmId)}/permissions`,
    });
    return Array.isArray(raw?.permissions) ? raw.permissions : [];
  }
}

function normalizePage(raw: unknown): RoleListPage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { items: [], next_cursor: null };
  }
  const obj = raw as Record<string, unknown>;
  const items = Array.isArray(obj["items"]) ? (obj["items"] as RoleObject[]) : [];
  let next: string | null = null;
  const nc = obj["next_cursor"];
  if (typeof nc === "string" && nc.length > 0) next = nc;
  const out: RoleListPage = { items, next_cursor: next };
  if (typeof obj["total"] === "number") out.total = obj["total"] as number;
  return out;
}

// ---------------------------------------------------------------------------
// Role predicates — ADR-081 assignability and ADR-101 D6 authority.
//
// ⚠️ THE ISSUER WINS. These are client-side MIRRORS of rules the server owns:
//
//   issuer/internal/realmrole/assignable.go    AssignableToKind,
//                                              HumanOnlyPermissions
//   issuer/internal/httpapi/role_assignable.go requireRoleAssignableToKind
//   issuer/internal/realmrole/permissions.go   Catalog, IsMutatingPermission,
//                                              ConfersAuthority
//
// Nothing here is a security control — every assignment path is validated
// server-side and answers `400 role_not_assignable_to_kind` or
// `403 role_owner_only`. They exist so a console never OFFERS a choice whose
// every save will 403. If these and the issuer ever disagree, the issuer is
// right and this file is what changes. `roles-drift.test.ts` is the gate that
// says so out loud.
// ---------------------------------------------------------------------------

/**
 * The shape these predicates read off a role.
 *
 * DERIVED from {@link RoleObject} rather than declared as a parallel interface,
 * deliberately. A hand-written structural mirror is what let ADR-101's removal
 * of `required_mfa_methods` sit undetected in a console for a release: the
 * compiler had nothing to compare against. Deriving means the next wire change
 * shows up here as a type error.
 */
export type AssignableRole = Pick<RoleObject, "name"> &
  Partial<Pick<RoleObject, "permissions" | "assignable_to" | "is_system" | "disabled">>;

/**
 * ADR-081 §2.3 — the grants that require a human in the loop, because each is
 * a path by which a leaked machine credential escalates to realm-wide control.
 * Mirrors `realmrole.HumanOnlyPermissions`; drift-tested.
 *
 * `roles:manage` is absent because ADR-091 D3 RETIRED it from the catalog
 * outright — role administration is the ADR-076 owner pointer now, so there is
 * no permission string left to withhold from a service principal.
 */
export const HUMAN_ONLY_PERMISSIONS: ReadonlySet<string> = new Set([
  "signing_keys:rotate", // realm-wide credential operation
  "domains:manage", // changes the realm's identity surface
  "platform:config", // realm-wide policy
  "federation:manage", // establishes cross-realm trust
]);

/**
 * Role names no assignment path accepts, because they are SYSTEM rows moved by
 * something other than a role write: `owner` travels through the ADR-076
 * ownership pointer, and `platform_api` backs the API-key bot (ADR-041).
 *
 * A CONSOLE-side rule, not part of {@link isRoleAssignableTo}'s server mirror —
 * the issuer refuses these on the specific endpoints rather than in the
 * assignability predicate. Applied by {@link isRoleSeatable}.
 */
const SYSTEM_UNASSIGNABLE: ReadonlySet<string> = new Set(["owner", "platform_api"]);

/**
 * Whether a principal of `kind` may hold `role` — the exact mirror of the
 * issuer's `requireRoleAssignableToKind`.
 *
 * EMPTY or ABSENT `assignable_to` means ANY. Since ADR-081 § Amendment 2 the
 * issuer no longer STORES an empty set, so this branch fires only for a
 * response from an older server that omits the field — and degrading to "any"
 * there is exactly right: it reproduces pre-ADR-081 behaviour instead of
 * emptying every picker. Read-time fails open; write-time enforces.
 *
 * Two floors then apply to a `service` principal regardless of what the
 * partner declared:
 *
 *  - {@link HUMAN_ONLY_PERMISSIONS} — a machine credential must not be able to
 *    become a realm-control credential;
 *  - ADR-091's exemption for `is_system` roles, which are RI-managed and hold
 *    realm-control permissions BY CONSTRUCTION (`platform_api` is the realm's
 *    machine identity). Without it the bot role is unassignable to the bot.
 *
 * There is NO per-role MFA floor. ADR-101 retired `required_mfa_methods`
 * (no realm ever configured one); a server still emitting the field must not
 * change the answer here.
 *
 * This is the SERVER's predicate, so it says nothing about `owner`,
 * `platform_api` or disabled roles. For a picker use {@link isRoleSeatable} or
 * {@link rolesAssignableTo}.
 */
export function isRoleAssignableTo(role: AssignableRole, kind: PrincipalKind): boolean {
  const declared = role.assignable_to ?? [];
  if (declared.length > 0 && !declared.includes(kind)) return false;
  if (kind !== "service") return true;
  if (role.is_system) return true;
  return !(role.permissions ?? []).some((p) => HUMAN_ONLY_PERMISSIONS.has(p));
}

/**
 * Whether a console should OFFER `role` for a principal of `kind`.
 *
 * {@link isRoleAssignableTo} plus the two guards the issuer enforces on the
 * endpoints rather than in its assignability predicate: a system-unassignable
 * name (`owner`, `platform_api`) and a soft-disabled role, which stays in the
 * catalog but is rejected as an assignment target.
 *
 * This is the predicate a role picker wants. Reaching for
 * {@link isRoleAssignableTo} instead will offer `owner`.
 */
export function isRoleSeatable(role: AssignableRole, kind: PrincipalKind): boolean {
  if (SYSTEM_UNASSIGNABLE.has(role.name)) return false;
  if (role.disabled) return false;
  return isRoleAssignableTo(role, kind);
}

/**
 * Filter a role catalog down to what `kind` may actually be seated at, in
 * catalog order. Uses {@link isRoleSeatable}.
 */
export function rolesAssignableTo<T extends AssignableRole>(
  roles: readonly T[],
  kind: PrincipalKind,
): T[] {
  return roles.filter((r) => isRoleSeatable(r, kind));
}

/** Options for {@link confersAuthority}. */
export interface ConfersAuthorityOptions {
  /**
   * The realm's served ADR-074 catalog (`roles.listPermissions()`).
   *
   * Supply it and classification matches the issuer EXACTLY, including its
   * fail-closed answer for a grant string the catalog does not name. Omit it
   * and the action is derived from the `resource:action` string itself, which
   * agrees with the issuer for every catalog entry (drift-tested) and differs
   * only for strings outside the catalog — which the server refuses at write
   * time anyway.
   */
  catalog?: readonly CatalogPermission[];
}

/**
 * ADR-101 D6 — does this role CONFER AUTHORITY?
 *
 * Nobody but the tenant OWNER may seat a principal at such a role, on any of
 * the four paths that write `users.role` (invite, role change, bulk import,
 * service-account create). The server enforces it and answers
 * `403 role_owner_only`; this is the client-side mirror, so a picker does not
 * offer a choice whose every save 403s.
 *
 * **Derived from the permission set, NEVER from the name.** That is the whole
 * point of D6: "admin" is a string. A realm may hold a role called `admin`
 * with no permissions and one called `reporting` that can revoke sessions. The
 * predicate is "grants anything whose ACTION is not `read`" — exactly how the
 * issuer derives it from the ADR-074 catalog, and why a role RI adds later is
 * classified correctly the moment it exists, with no list to forget.
 *
 * FAIL-CLOSED on anything unparseable: a permission is `resource:action`, and
 * an entry with no colon is treated as CONFERRING, because a grant we cannot
 * read must not be assumed harmless. An empty string is a blank rather than an
 * unknown grant and confers nothing — the same answer the issuer's
 * `IsMutatingPermission("")` gives.
 */
export function confersAuthority(
  role: { permissions?: readonly string[] | null },
  opts?: ConfersAuthorityOptions,
): boolean {
  const known = opts?.catalog
    ? new Map(opts.catalog.map((p) => [p.key, p.action]))
    : undefined;
  for (const p of role.permissions ?? []) {
    if (p === "") continue;
    if (known) {
      const action = known.get(p);
      // Unknown to the catalog: fail closed, as realmrole.IsMutatingPermission
      // does. An unrecognised grant is not harmless just because it is absent.
      if (action === undefined || action !== "read") return true;
      continue;
    }
    const colon = p.indexOf(":");
    if (colon < 0) return true;
    if (p.slice(colon + 1) !== "read") return true;
  }
  return false;
}
