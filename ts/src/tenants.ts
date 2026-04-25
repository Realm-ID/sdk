/**
 * Tenants management — SPEC §6.1, §6.2, §6.3.
 * Includes nested `invitations` and `users` namespaces.
 */

import type { HttpClient } from "./http.js";
import { paginate, type Paginated, type Page, type PageOpts } from "./pagination.js";

export interface Tenant {
  id: string;
  display_name?: string;
  owner_user_id?: string;
  config?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  [k: string]: unknown;
}

export interface TenantCreate {
  displayName: string;
  ownerUserId?: string;
  config?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface TenantPatch {
  displayName?: string;
  [k: string]: unknown;
}

export interface Invitation {
  id: string;
  tenant_id: string;
  email: string;
  role?: string;
  status?: string;
  [k: string]: unknown;
}

export interface InvitationCreate {
  email: string;
  role?: string;
  [k: string]: unknown;
}

export interface User {
  id: string;
  email?: string;
  display_name?: string;
  status?: string;
  mfa_enabled?: boolean;
  role?: string;
  [k: string]: unknown;
}

export type UserStatus = "active" | "suspended" | "deactivated";

interface PageEnv<T> {
  items?: T[];
  data?: T[];
  next_cursor?: string;
  cursor?: string;
}

function readPage<T>(raw: PageEnv<T> | T[]): Page<T> {
  if (Array.isArray(raw)) return { items: raw };
  return {
    items: raw.items ?? raw.data ?? [],
    nextCursor: raw.next_cursor ?? raw.cursor,
  };
}

export class InvitationsClient {
  constructor(private readonly http: HttpClient) {}

  list(tenantId: string, opts?: PageOpts): Paginated<Invitation> {
    return paginate<Invitation>(async (po) => {
      const raw = await this.http.request<PageEnv<Invitation> | Invitation[]>({
        method: "GET",
        path: `/tenants/${encodeURIComponent(tenantId)}/invitations`,
        query: { cursor: po.cursor, limit: po.limit ?? opts?.limit },
      });
      return readPage(raw);
    });
  }

  async create(tenantId: string, body: InvitationCreate): Promise<Invitation> {
    return this.http.request<Invitation>({
      method: "POST",
      path: `/tenants/${encodeURIComponent(tenantId)}/invitations`,
      body,
    });
  }

  async delete(tenantId: string, invitationId: string): Promise<void> {
    await this.http.request({
      method: "DELETE",
      path: `/tenants/${encodeURIComponent(tenantId)}/invitations/${encodeURIComponent(invitationId)}`,
    });
  }
}

export class UsersClient {
  constructor(private readonly http: HttpClient) {}

  list(tenantId: string, opts?: PageOpts): Paginated<User> {
    return paginate<User>(async (po) => {
      const raw = await this.http.request<PageEnv<User> | User[]>({
        method: "GET",
        path: `/tenants/${encodeURIComponent(tenantId)}/users`,
        query: { cursor: po.cursor, limit: po.limit ?? opts?.limit },
      });
      return readPage(raw);
    });
  }

  async get(tenantId: string, userId: string): Promise<User> {
    return this.http.request<User>({
      method: "GET",
      path: `/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}`,
    });
  }

  async updateStatus(tenantId: string, userId: string, status: UserStatus): Promise<User> {
    return this.http.request<User>({
      method: "PATCH",
      path: `/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/status`,
      body: { status },
    });
  }

  async enrollMfa(tenantId: string, userId: string): Promise<{ secret?: string; otpauth_uri?: string; [k: string]: unknown }> {
    return this.http.request({
      method: "POST",
      path: `/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/mfa/enroll`,
    });
  }

  async confirmMfa(tenantId: string, userId: string, code: string): Promise<{ status: string; [k: string]: unknown }> {
    return this.http.request({
      method: "POST",
      path: `/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/mfa/confirm`,
      body: { code },
    });
  }

  async resetMfa(tenantId: string, userId: string): Promise<void> {
    await this.http.request({
      method: "DELETE",
      path: `/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/mfa`,
    });
  }
}

export class TenantsClient {
  readonly invitations: InvitationsClient;
  readonly users: UsersClient;

  constructor(private readonly http: HttpClient) {
    this.invitations = new InvitationsClient(http);
    this.users = new UsersClient(http);
  }

  list(opts?: PageOpts): Paginated<Tenant> {
    return paginate<Tenant>(async (po) => {
      const raw = await this.http.request<PageEnv<Tenant> | Tenant[]>({
        method: "GET",
        path: "/tenants",
        query: { cursor: po.cursor, limit: po.limit ?? opts?.limit },
      });
      return readPage(raw);
    });
  }

  async get(id: string): Promise<Tenant> {
    return this.http.request<Tenant>({
      method: "GET",
      path: `/tenants/${encodeURIComponent(id)}`,
    });
  }

  async create(body: TenantCreate): Promise<Tenant> {
    return this.http.request<Tenant>({
      method: "POST",
      path: "/tenants",
      body: {
        display_name: body.displayName,
        owner_user_id: body.ownerUserId,
        config: body.config,
        ...rest(body, ["displayName", "ownerUserId", "config"]),
      },
    });
  }

  async update(id: string, patch: TenantPatch): Promise<Tenant> {
    return this.http.request<Tenant>({
      method: "PATCH",
      path: `/tenants/${encodeURIComponent(id)}`,
      body: {
        display_name: patch.displayName,
        ...rest(patch, ["displayName"]),
      },
    });
  }

  async updateConfig(id: string, patch: Record<string, unknown>): Promise<Tenant> {
    return this.http.request<Tenant>({
      method: "PATCH",
      path: `/tenants/${encodeURIComponent(id)}/config`,
      body: patch,
    });
  }

  async delete(id: string): Promise<void> {
    await this.http.request({
      method: "DELETE",
      path: `/tenants/${encodeURIComponent(id)}`,
    });
  }

  async transferOwner(id: string, newOwnerUserId: string): Promise<Tenant> {
    return this.http.request<Tenant>({
      method: "PUT",
      path: `/tenants/${encodeURIComponent(id)}/owner`,
      body: { owner_user_id: newOwnerUserId },
    });
  }
}

function rest<T extends Record<string, unknown>>(obj: T, omit: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!omit.includes(k) && v !== undefined) out[k] = v;
  }
  return out;
}
