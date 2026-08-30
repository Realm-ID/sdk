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
 * A grantable permission from the fixed ADR-074 catalog
 * (`GET /platforms/{id}/permissions`). These gate RI *admin-console*
 * operations for the platform — not the partner's own product RBAC.
 */
export interface Permission {
  key: string;
  resource: string;
  action: string;
  label: string;
}

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
