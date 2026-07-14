/**
 * Service accounts — `realm.serviceAccounts.*` (ADR-071 §2/§10).
 *
 * A service account is a first-class non-human identity (`kind=service`)
 * that logs in via a `view_bff` OTP (never a human provider). This is the
 * owner/admin management surface over `/tenants/{id}/service-accounts`.
 *
 * Authorization is the realm's short-lived platform token — exactly like the
 * Roles client. The HttpClient auto-attaches it; this module never handles the
 * API key. The issuer gates each call with `requireServiceAccountManage`
 * (owner OR admin of the tenant, or the realm's own M2M token).
 *
 * Server error codes surface on `RealmError.code`: `handle_taken` (409),
 * `invalid_role` (400), `service_account_not_found` / `user_not_found` (404).
 */

import type { HttpClient } from "./http.js";

/** One `kind=service` account (issuer serviceAccountDTO). */
export interface ServiceAccount {
  id: string;
  /** Email-shaped login handle (contains `@`), unique in the tenant. */
  handle: string;
  role: string;
  status: string;
  kind: string;
  display_name?: string;
  created_at?: string;
  [k: string]: unknown;
}

/** POST /tenants/{id}/service-accounts body. */
export interface ServiceAccountCreate {
  /** Email-shaped login handle (must contain `@`), unique in the tenant. */
  handle: string;
  /** Tenant role; must not be `owner` or `platform_api`. Defaults to `member`. */
  role?: string;
  /** Optional display name; defaults to the handle. */
  displayName?: string;
}

/** POST …/{said}/revoke response. */
export interface ServiceAccountRevokeResult {
  status: string;
  revoked_sessions: number;
  [k: string]: unknown;
}

interface ServiceAccountList {
  items?: ServiceAccount[];
}

export class ServiceAccountsClient {
  constructor(private readonly http: HttpClient) {}

  private base(tenantId: string): string {
    return `/tenants/${encodeURIComponent(tenantId)}/service-accounts`;
  }

  /** POST /tenants/{id}/service-accounts — provision a service account. */
  async create(tenantId: string, body: ServiceAccountCreate): Promise<ServiceAccount> {
    const wire: Record<string, unknown> = { handle: body.handle };
    if (body.role !== undefined) wire["role"] = body.role;
    if (body.displayName !== undefined) wire["display_name"] = body.displayName;
    return this.http.request<ServiceAccount>({
      method: "POST",
      path: this.base(tenantId),
      body: wire,
    });
  }

  /** GET /tenants/{id}/service-accounts — every service account in a tenant. */
  async list(tenantId: string): Promise<ServiceAccount[]> {
    const raw = await this.http.request<ServiceAccountList>({
      method: "GET",
      path: this.base(tenantId),
    });
    return raw?.items ?? [];
  }

  /** GET /tenants/{id}/service-accounts/{said}. */
  async get(tenantId: string, id: string): Promise<ServiceAccount> {
    return this.http.request<ServiceAccount>({
      method: "GET",
      path: `${this.base(tenantId)}/${encodeURIComponent(id)}`,
    });
  }

  /** POST …/{said}/reset-handle — change the login handle (unique-in-tenant). */
  async resetHandle(tenantId: string, id: string, handle: string): Promise<ServiceAccount> {
    return this.action(tenantId, id, "reset-handle", { handle });
  }

  /** POST …/{said}/suspend — suspend and drop live sessions. */
  async suspend(tenantId: string, id: string): Promise<ServiceAccount> {
    return this.action(tenantId, id, "suspend");
  }

  /** POST …/{said}/unsuspend — restore a suspended account. */
  async unsuspend(tenantId: string, id: string): Promise<ServiceAccount> {
    return this.action(tenantId, id, "unsuspend");
  }

  /** POST …/{said}/deactivate — soft-delete (status=deactivated) + revoke sessions. */
  async deactivate(tenantId: string, id: string): Promise<ServiceAccount> {
    return this.action(tenantId, id, "deactivate");
  }

  /**
   * POST …/{said}/revoke — drop all live sessions without changing status
   * (the account can log in again).
   */
  async revoke(tenantId: string, id: string): Promise<ServiceAccountRevokeResult> {
    return this.http.request<ServiceAccountRevokeResult>({
      method: "POST",
      path: `${this.base(tenantId)}/${encodeURIComponent(id)}/revoke`,
    });
  }

  private async action(
    tenantId: string,
    id: string,
    verb: string,
    body?: Record<string, unknown>,
  ): Promise<ServiceAccount> {
    return this.http.request<ServiceAccount>({
      method: "POST",
      path: `${this.base(tenantId)}/${encodeURIComponent(id)}/${verb}`,
      body,
    });
  }
}
