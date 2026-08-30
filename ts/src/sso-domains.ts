/**
 * Per-org SSO domain grants — ADR-094. TYPES ONLY.
 *
 * A grant answers "which organisation may a verified `@acme.com` address be
 * provisioned into". Deliberately NOT the same thing as the tenant *domains*
 * surface (ADR-049 ROUTING: which hostname serves this org). They read
 * different tables and follow different subdomain rules — routing lets a
 * verified apex cover its subdomains, an SSO grant matches EXACTLY. Conflating
 * them is the mistake ADR-094's resolver re-point exists to prevent: a routing
 * domain must not confer SSO.
 *
 * Domain uniqueness is PER-PLATFORM, so two partners can each serve the same
 * customer domain.
 *
 * ⚠️ Partners MUST surface this flow themselves. An org cannot self-serve from
 * an RI-hosted console, so either the partner renders the claim/verify screens
 * or the platform owner acts on the org's behalf. That is why the shapes belong
 * in the SDK rather than in RealmID's own console.
 *
 * The transport (`admin.ssoDomains`) lands in `@realm-id/web-admin`; these are
 * the wire shapes it resolves to.
 *
 * The two closed vocabularies are declared as const ARRAYS with the union
 * derived from them, so `roles-drift.test.ts` can compare them against
 * `issuer/internal/tenantdomain/tenantdomain.go`. A union alone is invisible at
 * runtime, which is another way of saying it cannot be drift-tested.
 */

/**
 * How a grant was established.
 *
 * The three proof methods (`dns_txt`, `html_file`, `meta_tag`) are REAL
 * evidence the claimant controls the domain. `platform_approval` is the
 * platform owner attesting on the org's behalf, and `self_asserted` is the
 * org's own word — neither is proof, and neither sets `verified`.
 */
export const SSO_DOMAIN_METHODS = [
  "dns_txt",
  "html_file",
  "meta_tag",
  "platform_approval",
  "self_asserted",
] as const;
export type SSODomainMethod = (typeof SSO_DOMAIN_METHODS)[number];

/** The three methods that are REAL proof, i.e. the only ones that set `verified`. */
export const SSO_DOMAIN_PROOF_METHODS: readonly SSODomainMethod[] = [
  "dns_txt",
  "html_file",
  "meta_tag",
];

/**
 * Grant lifecycle.
 *
 * `failed` is reached by a PROVEN grant whose periodic re-check has been
 * failing for 7 days (see `check_failing_since`) — it is decay, not a rejection.
 * `revoked` starts a 7-day cooldown before the domain can be re-claimed.
 */
export const SSO_DOMAIN_STATUSES = [
  "claimed",
  "pending",
  "active",
  "suspended",
  "rejected",
  "revoked",
  "failed",
] as const;
export type SSODomainStatus = (typeof SSO_DOMAIN_STATUSES)[number];

/** One SSO domain grant. Timestamps are RFC 3339 strings, not unix seconds. */
export interface SSODomainGrant {
  id: string;
  tenant_id: string;
  domain: string;
  method: SSODomainMethod;
  status: SSODomainStatus;
  /**
   * TRUE only for REAL proof — never for an approval or a self-assertion.
   *
   * Render THIS, never an inference from `status`: an `active` grant may be
   * live on nothing more than the platform owner's word, and showing that as
   * "verified" is precisely the confusion the server's schema keeps apart.
   */
  verified: boolean;
  verified_at?: string;
  approved_at?: string;
  rejected_reason?: string;
  requested_at: string;
  last_checked_at?: string;
  /** Set while a proven grant's periodic re-check is failing; 7 days → `failed`. */
  check_failing_since?: string;
  /** Re-claiming is refused until this passes (set on revoke). */
  cooldown_until?: string;
  created_at: string;
  [k: string]: unknown;
}

/**
 * What the claimant must publish to prove the domain. Present only for the
 * three proof methods; an approval or self-assertion has nothing to publish.
 */
export interface SSODomainInstructions {
  dns_record_name?: string;
  dns_record_value?: string;
  file_path?: string;
  file_content?: string;
}

/** The claim response: the new grant plus what to publish to prove it. */
export interface SSODomainClaimResult {
  grant: SSODomainGrant;
  instructions?: SSODomainInstructions;
}

/**
 * The verify response.
 *
 * A FAILED check is NOT an error — it answers 200 with `verified: false`,
 * because "the record is not published yet" is the normal state while a
 * customer is still setting DNS up. A client that treats it as a failure will
 * show an error to every user who is simply not done.
 */
export interface SSODomainVerifyResult {
  grant: SSODomainGrant;
  verified: boolean;
}
