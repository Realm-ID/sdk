/**
 * Realm SPA origins (custom domains) — the owner-scoped, post-bootstrap
 * origin surface at `/platforms/{id}/origins*` (ADR-049), reached via the
 * BFF `/api` passthrough. Distinct from `PlatformsClient.claimDomain`,
 * which drives the LEGACY user-scoped `/domains/claim` used only during
 * first-run onboarding: those DV rows are `owner_type='user'`, whereas an
 * origin bind (`POST /platforms/{id}/origins`) requires a verified DV row
 * owned by the *realm*. Use this client to attach a custom domain to an
 * already-created platform.
 *
 * Flow: `claim(id, {domain})` → add the returned TXT record → `verify(id,
 * {domain})` → `bind(id, {domain})`. A subdomain of an already-verified
 * apex bound to the realm skips claim/verify (trusted-by-parent, ADR-049
 * §3) — `bind` succeeds directly.
 */

import type { HttpLike } from "./transport.js";
import type { DomainClaimResponse, Origin, OriginBindResult } from "./types.js";

export class OriginsClient {
  constructor(private readonly http: HttpLike) {}

  /** GET /platforms/{id}/origins — the realm's currently-bound origins. */
  async list(platformId: string): Promise<Origin[]> {
    const d = await this.http.request<{ items?: Origin[] }>({
      method: "GET",
      path: `/platforms/${encodeURIComponent(platformId)}/origins`,
    });
    return d?.items ?? [];
  }

  /**
   * POST /platforms/{id}/origins/claim — start realm-scoped DNS
   * verification for a custom domain. Idempotent per (realm, domain):
   * re-claiming a pending domain returns the same TXT record.
   */
  async claim(platformId: string, input: { domain: string }): Promise<DomainClaimResponse> {
    return this.http.request<DomainClaimResponse>({
      method: "POST",
      path: `/platforms/${encodeURIComponent(platformId)}/origins/claim`,
      body: input,
    });
  }

  /**
   * POST /platforms/{id}/origins/verify — run the DNS check on the pending
   * claim and persist the result. Does NOT bind; call `bind` after this
   * returns `{ status: "verified" }`.
   */
  async verify(platformId: string, input: { domain: string }): Promise<{ status: string }> {
    return this.http.request<{ status: string }>({
      method: "POST",
      path: `/platforms/${encodeURIComponent(platformId)}/origins/verify`,
      body: input,
    });
  }

  /**
   * POST /platforms/{id}/origins — bind a verified (or trusted-by-parent)
   * domain as a realm origin. 409 `domain_taken`; 412 `domain_not_verified`.
   */
  async bind(platformId: string, input: { domain: string }): Promise<OriginBindResult> {
    return this.http.request<OriginBindResult>({
      method: "POST",
      path: `/platforms/${encodeURIComponent(platformId)}/origins`,
      body: input,
    });
  }

  /**
   * DELETE /platforms/{id}/origins/{originId} — detach an origin (revokes
   * realm sessions). 409 `last_origin` when it's the only live origin.
   */
  async remove(platformId: string, originId: string): Promise<{ status?: string }> {
    return this.http.request<{ status?: string }>({
      method: "DELETE",
      path: `/platforms/${encodeURIComponent(platformId)}/origins/${encodeURIComponent(originId)}`,
    });
  }
}
