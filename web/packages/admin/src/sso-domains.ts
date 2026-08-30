/**
 * Per-org SSO domain grants — ADR-094.
 *
 * A grant answers "which organisation may a verified `@acme.com` address be
 * provisioned into". Deliberately NOT the same thing as the tenant *domains*
 * surface ({@link DomainsClient}, ADR-049 ROUTING: which hostname serves this
 * org). They read different tables and follow different subdomain rules —
 * routing lets a verified apex cover its subdomains, an SSO grant matches
 * EXACTLY. Conflating them is the mistake ADR-094's resolver re-point exists to
 * prevent: a routing domain must not confer SSO.
 *
 * ⚠️ **Partners MUST surface this flow themselves.** An org cannot self-serve
 * from an RI-hosted console, so either the partner renders the claim/verify
 * screens or the platform owner acts on the org's behalf. That is exactly why
 * this is SDK surface and not console code.
 *
 * TWO audiences on one resource, and the paths differ:
 *   - the ORG-scoped calls ({@link list}, {@link claim}, {@link verify},
 *     {@link request}, {@link revoke}) hit
 *     `/platforms/{pid}/tenants/{tid}/sso-domains…`;
 *   - the PLATFORM-owner queue ({@link listForPlatform}, {@link approve},
 *     {@link reject}) hits `/platforms/{pid}/sso-domains…` and addresses a
 *     grant by its **id**, not its domain.
 * Route list: `issuer/internal/httpapi/routes.go:281-290`.
 *
 * The wire types (`SSODomainGrant`, the method/status vocabularies) live in
 * `@realm-id/sdk` and are drift-tested there against
 * `issuer/internal/tenantdomain/tenantdomain.go`. This file is transport only —
 * it must never declare its own copy of them.
 */

import type {
  SSODomainGrant,
  SSODomainMethod,
  SSODomainClaimResult,
  SSODomainVerifyResult,
} from "@realm-id/sdk";

import type { HttpLike } from "./transport.js";

/** Filters for the platform owner's approval queue. */
export interface ListPlatformSSODomainsOpts {
  /** One status, or a comma-separated list (`"claimed,pending"`). */
  status?: string;
}

export class SSODomainsClient {
  /** `realmId` is the PLATFORM id every path is scoped to. */
  constructor(private readonly http: HttpLike, private readonly realmId: string) {}

  private orgBase(tenantId: string): string {
    return `/platforms/${encodeURIComponent(this.realmId)}/tenants/${encodeURIComponent(tenantId)}/sso-domains`;
  }

  private platformBase(): string {
    return `/platforms/${encodeURIComponent(this.realmId)}/sso-domains`;
  }

  /** List one organisation's SSO domain grants. */
  async list(tenantId: string): Promise<SSODomainGrant[]> {
    const page = await this.http.request<{ items?: SSODomainGrant[] }>({
      method: "GET",
      path: this.orgBase(tenantId),
    });
    return page?.items ?? [];
  }

  /**
   * Claim a domain for SSO. `method` is optional: omit it and the server
   * applies its own default (`dns_txt`) rather than the client guessing one.
   * The result carries the {@link SSODomainClaimResult.instructions} the
   * claimant must publish — present only for the three PROOF methods.
   */
  async claim(
    tenantId: string,
    domain: string,
    method?: SSODomainMethod,
  ): Promise<SSODomainClaimResult> {
    return this.http.request<SSODomainClaimResult>({
      method: "POST",
      path: this.orgBase(tenantId),
      body: method ? { domain, method } : { domain },
    });
  }

  /**
   * Run the proof check.
   *
   * A FAILED check is NOT an error — it answers 200 with `verified: false`,
   * because "the record is not published yet" is the normal state while a
   * customer is still setting DNS up. Rendering that as a failure shows an
   * error to every user who is simply not finished.
   */
  async verify(tenantId: string, domain: string): Promise<SSODomainVerifyResult> {
    return this.http.request<SSODomainVerifyResult>({
      method: "POST",
      path: `${this.orgBase(tenantId)}/${encodeURIComponent(domain)}/verify`,
    });
  }

  /** Ask the platform owner to attest a domain this org cannot prove itself. */
  async request(tenantId: string, domain: string): Promise<SSODomainGrant> {
    return this.http.request<SSODomainGrant>({
      method: "POST",
      path: `${this.orgBase(tenantId)}/${encodeURIComponent(domain)}/request`,
    });
  }

  /** Give up (or take away) a grant. Starts a 7-day re-claim cooldown. */
  async revoke(tenantId: string, domain: string): Promise<SSODomainGrant> {
    return this.http.request<SSODomainGrant>({
      method: "DELETE",
      path: `${this.orgBase(tenantId)}/${encodeURIComponent(domain)}`,
    });
  }

  /** The platform owner's queue across every org in the realm. */
  async listForPlatform(opts?: ListPlatformSSODomainsOpts): Promise<SSODomainGrant[]> {
    const page = await this.http.request<{ items?: SSODomainGrant[] }>({
      method: "GET",
      path: this.platformBase(),
      query: opts?.status ? { status: opts.status } : undefined,
    });
    return page?.items ?? [];
  }

  /**
   * Attest a grant on the org's behalf (`platform_approval`).
   *
   * Addressed by GRANT ID, not domain. Note this does NOT set `verified` — an
   * approval is the owner's word, not proof, and the schema keeps the two
   * apart on purpose.
   */
  async approve(grantId: string): Promise<SSODomainGrant> {
    return this.http.request<SSODomainGrant>({
      method: "POST",
      path: `${this.platformBase()}/${encodeURIComponent(grantId)}/approve`,
    });
  }

  /** Refuse a requested grant, optionally recording why. */
  async reject(grantId: string, reason?: string): Promise<SSODomainGrant> {
    return this.http.request<SSODomainGrant>({
      method: "POST",
      path: `${this.platformBase()}/${encodeURIComponent(grantId)}/reject`,
      body: reason ? { reason } : undefined,
    });
  }
}
