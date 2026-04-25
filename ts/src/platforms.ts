/**
 * Platform admin — SPEC §6.5. For callers whose API key carries the
 * platform-admin role.
 */

import type { HttpClient } from "./http.js";

export interface Platform {
  id: string;
  display_name?: string;
  domain?: string;
  owner_user_id?: string;
  [k: string]: unknown;
}

export interface PlatformCreate {
  displayName: string;
  domain?: string;
  [k: string]: unknown;
}

export interface PlatformTenant {
  id: string;
  platform_id: string;
  display_name?: string;
  [k: string]: unknown;
}

export class PlatformTenantInvitationsClient {
  constructor(private readonly http: HttpClient) {}

  async create(
    platformId: string,
    tenantId: string,
    body: { email: string; role?: string; [k: string]: unknown },
  ): Promise<{ id: string; [k: string]: unknown }> {
    return this.http.request({
      method: "POST",
      path: `/platforms/${encodeURIComponent(platformId)}/tenants/${encodeURIComponent(tenantId)}/invitations`,
      body,
    });
  }
}

export class PlatformTenantsClient {
  readonly invitations: PlatformTenantInvitationsClient;
  constructor(private readonly http: HttpClient) {
    this.invitations = new PlatformTenantInvitationsClient(http);
  }

  async list(platformId: string): Promise<PlatformTenant[]> {
    const raw = await this.http.request<{ items?: PlatformTenant[] } | PlatformTenant[]>({
      method: "GET",
      path: `/platforms/${encodeURIComponent(platformId)}/tenants`,
    });
    return Array.isArray(raw) ? raw : (raw.items ?? []);
  }

  async create(platformId: string, body: { displayName: string; [k: string]: unknown }): Promise<PlatformTenant> {
    return this.http.request<PlatformTenant>({
      method: "POST",
      path: `/platforms/${encodeURIComponent(platformId)}/tenants`,
      body: { display_name: body.displayName, ...omit(body, ["displayName"]) },
    });
  }
}

export class PlatformsClient {
  readonly tenants: PlatformTenantsClient;

  constructor(private readonly http: HttpClient) {
    this.tenants = new PlatformTenantsClient(http);
  }

  /** Same as `mine()` per SPEC §6.5. */
  list(): Promise<Platform[]> {
    return this.mine();
  }

  async mine(): Promise<Platform[]> {
    const raw = await this.http.request<{ items?: Platform[]; platforms?: Platform[] } | Platform[]>({
      method: "GET",
      path: "/platforms/mine",
    });
    if (Array.isArray(raw)) return raw;
    return raw.items ?? raw.platforms ?? [];
  }

  async create(body: PlatformCreate): Promise<Platform> {
    return this.http.request<Platform>({
      method: "POST",
      path: "/platforms",
      body: { display_name: body.displayName, domain: body.domain, ...omit(body, ["displayName", "domain"]) },
    });
  }
}

function omit<T extends Record<string, unknown>>(obj: T, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!keys.includes(k) && v !== undefined) out[k] = v;
  }
  return out;
}
