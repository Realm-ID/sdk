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

export interface RoleObject {
  id: string;
  name: string;
  display_name?: string;
  permissions: string[];
  is_system: boolean;
  created_at: number;
  updated_at: number;
  [k: string]: unknown;
}

export interface RoleListPage {
  items: RoleObject[];
  next_cursor: string | null;
  total?: number;
}

export interface RoleListOpts {
  cursor?: string;
  limit?: number;
}

export interface RoleCreate {
  name: string;
  displayName?: string;
  permissions?: string[];
}

export interface RolePatch {
  displayName?: string;
  permissions?: string[];
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
      query: { cursor: opts?.cursor, limit: opts?.limit },
    });
    return normalizePage(raw);
  }

  async create(body: RoleCreate): Promise<RoleObject> {
    const wire: Record<string, unknown> = { name: body.name };
    if (body.displayName !== undefined) wire["display_name"] = body.displayName;
    if (body.permissions !== undefined) wire["permissions"] = body.permissions;
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
    return this.http.request<RoleObject>({
      method: "PATCH",
      path: `/platforms/${encodeURIComponent(this.realmId)}/roles/${encodeURIComponent(roleId)}`,
      body: wire,
    });
  }

  async delete(roleId: string): Promise<{ status: "deleted" }> {
    return this.http.request<{ status: "deleted" }>({
      method: "DELETE",
      path: `/platforms/${encodeURIComponent(this.realmId)}/roles/${encodeURIComponent(roleId)}`,
    });
  }

  async rename(roleId: string, opts: { to: string }): Promise<RoleObject> {
    return this.http.request<RoleObject>({
      method: "POST",
      path: `/platforms/${encodeURIComponent(this.realmId)}/roles/${encodeURIComponent(roleId)}/rename`,
      body: { to: opts.to },
    });
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
