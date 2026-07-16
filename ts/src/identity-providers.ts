/**
 * Public identity-provider discovery (SPEC §6.10). The platform-token-authed
 * endpoint a partner backend calls (through the SDK) to populate its login
 * provider list — distinct from the realm-admin IdP config CRUD in
 * `identity-provider-config.ts`. Mirrors the Go SDK's `Realm.IdentityProviders`.
 */

import type { HttpClient } from "./http.js";

/**
 * One row from the public identity-provider discovery endpoint. Admin-only
 * fields are stripped, leaving the minimum a SPA needs to render its login
 * provider list.
 */
export interface IdentityProvider {
  type: string;
  client_type: string;
  client_id: string;
  /** Provider PUBLIC config (e.g. the Firebase web config); absent when empty. */
  config?: Record<string, string>;
}

/**
 * Typed discovery result. `tenant_id` is set only when the issuer resolved the
 * call to a specific tenant (origin-passthrough or explicit `tenantId`); pass
 * it through on `auth.login` when present (required for method=google per
 * ADR-046).
 */
export interface IdentityProvidersResponse {
  tenant_id?: string;
  providers: IdentityProvider[];
}

/** Tunes the discovery call (all optional). */
export interface IdentityProvidersOptions {
  /** Narrows discovery to a client surface (web|ios|android|desktop|other).
   *  Empty defers to the issuer default (web). */
  platform?: string;
  /** Pins discovery to a specific tenant on this realm. Empty → Origin
   *  resolution (if any) or realm-scope. */
  tenantId?: string;
  /** Rides as the Origin header so the issuer's domain-mappings lookup can
   *  resolve a tenant from the caller's SPA origin (ADR-047 §1.0). */
  origin?: string;
}

/**
 * Public identity-provider discovery client (SPEC §6.10). Wraps
 * GET /platforms/{realmId}/identity-providers; the realm's platform token is
 * attached automatically.
 */
export class IdentityProvidersClient {
  constructor(private readonly http: HttpClient, private readonly realmId: string) {}

  async discover(opts?: IdentityProvidersOptions): Promise<IdentityProvidersResponse> {
    const headers: Record<string, string> = {};
    if (opts?.origin) headers["Origin"] = opts.origin;
    return this.http.request<IdentityProvidersResponse>({
      method: "GET",
      path: `/platforms/${encodeURIComponent(this.realmId)}/identity-providers`,
      query: { platform: opts?.platform, tenant_id: opts?.tenantId },
      headers: Object.keys(headers).length ? headers : undefined,
    });
  }
}
