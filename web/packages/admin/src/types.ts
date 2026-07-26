/**
 * Shared wire types for the admin SDK. Shapes mirror `ui/web/src/api.ts`
 * and the BFF's response envelopes — see `api/README.md` (formerly `bff-api/`) for the
 * canonical contract.
 */

export type SignupMode = "closed" | "allowlist" | "open";

export interface UserSummary {
  id: string;
  email?: string;
  phone?: string;
  display_name: string;
  role: string;
  status: string;
}

export interface TenantSummary {
  id: string;
  realm_id: string;
  display_name: string;
  allowed_domains: string[];
  custom_domain?: string;
  status: string;
  config: { mfa_policy?: string; signup_mode?: SignupMode };
  owner?: UserSummary | null;
  /**
   * Per-org dashboard columns (issuer v0.52.0), folded onto
   * `GET /platforms/{pid}/tenants` from ONE realm-scoped aggregate.
   *
   * Both are OPTIONAL ON THE WIRE ON PURPOSE: the issuer computes them
   * best-effort and omits them if the aggregate query fails, so `undefined`
   * means "not computed" and is distinct from a real `0` / "never active".
   * Render a `—`, not a zero, when absent.
   */
  users_count?: number;
  /** Unix seconds of the org's most recent activity; absent = never / not computed. */
  last_activity_at?: number;
}

export interface InvitationSummary {
  id: string;
  identifier: string;
  role: string;
  status: string;
  expires_at: number;
}

export interface DomainClaimResponse {
  domain: string;
  dns_record_name: string;
  dns_record_value: string;
  status: string;
}

/** A pending domain claim as listed by GET /domains/pending — the claim
 *  response shape plus when it was created and when the token expires. */
export interface PendingDomain extends DomainClaimResponse {
  created_at: number;
  expires_at: number;
}

/**
 * A realm SPA origin as listed by GET /platforms/{id}/origins (ADR-049).
 * Rows map a bare host to the realm; a `verification_id` links the
 * `domain_verifications` row that proved control (shared from a verified
 * parent apex under the trusted-by-parent shortcut, ADR-049 §3).
 */
export interface Origin {
  id: string;
  domain: string;
  entity_type: string;
  entity_id: string;
  verification_id?: string;
  created_at: number;
}

/**
 * Result of binding a verified domain as a realm origin
 * (POST /platforms/{id}/origins). `trusted_by_parent` + `parent_domain`
 * are set when the origin inherited a verified parent apex's DV row
 * instead of needing its own claim/verify (ADR-049 §3).
 */
export interface OriginBindResult {
  id: string;
  domain: string;
  entity_type: string;
  entity_id: string;
  verification_id: string;
  trusted_by_parent?: boolean;
  parent_domain?: string;
}

export interface PlatformCreatedResponse {
  platform_id: string;
  admin_tenant_id: string;
  domain: string;
}

export interface Platform {
  id: string;
  domain: string;
  admin_tenant_id: string;
  display_name: string;
  /**
   * ADR-075 platform-level MFA tri-state ("disabled"/"enabled"/"enforced").
   * Surfaced on GET /platforms/mine so the Settings MFA tab can prime the
   * control (the config PATCH has no GET counterpart). Omitted = "disabled".
   */
  mfa_policy?: "disabled" | "enabled" | "enforced";
}

export interface CreateApiKeyResponse {
  id: string;
  value: string;
  scope: string;
  label?: string;
}

// ---- API keys (issuer `/platforms/{id}/api-keys`, SPEC §6.5) ----

/** Body for `apiKeys.create`. `scope` is the key's bound role. */
export interface ApiKeyCreateInput {
  scope: string;
  label?: string;
  /**
   * Requested lifetime (ADR-085 §3). Omitting this AND `non_expiring`
   * applies the issuer's built-in 90-day default. Floor is 300s; below
   * it the create is rejected rather than clamped.
   */
  ttl_seconds?: number;
  /**
   * Request a permanent key. A realm holds at most one non-expiring key
   * and at most 2 active platform keys (ADR-085 §2), so create can fail
   * with `non_expiring_not_allowed` (400) or `too_many_api_keys` (409).
   */
  non_expiring?: boolean;
}

/**
 * Response from `apiKeys.create`. Carries the one-time `value` (raw
 * secret) — shown only on creation, never returned by `list`.
 */
export interface ApiKeyCreated {
  id: string;
  /** Scheduled cutoff, or `null` for a non-expiring key (ADR-085 §3). */
  expires_at?: number | null;
  value: string;
  scope: string;
  label?: string;
}

/**
 * A row from `apiKeys.list`. Mirrors the issuer's `APIKeyListItem`
 * exactly. The bound role surfaces as `role` (not the `scope` it was
 * created with). Timestamps are unix seconds; `last_used_at` /
 * `revoked_at` / `expires_at` are nullable.
 */
export interface ApiKeyListItem {
  id: string;
  prefix: string;
  /**
   * The label supplied at create. Present since issuer v0.61.0 —
   * previously the list omitted it, which is the gap ADR-085 §7 names:
   * the plaintext is never echoed and `prefix` is derived from the
   * stored hash, so an `rk_live_…` found in a log or a deployment
   * config cannot be traced to its row by value. The label is the only
   * handle, so render it. Empty string when none was supplied.
   */
  label: string;
  role: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  /**
   * Scheduled cutoff, or `null` for a non-expiring key (ADR-085 §3).
   * Null is a VALUE, not an absence — an admin UI must be able to show
   * "never expires" as distinct from "unknown".
   */
  expires_at: number | null;
}

export interface ApiKeyListPage {
  items: ApiKeyListItem[];
  next_cursor?: string | null;
  total?: number;
}

export interface ActiveSession {
  id: string;
  origin?: string;
  /** Human-readable device label recorded at login (e.g. a CLI hostname),
   *  surfaced so a user can tell sessions apart for revocation (ADR-062). */
  device_name?: string;
  created_at: number;
  last_seen_at?: number;
}

/**
 * Result of a member-scoped or realm-wide session revocation
 * (`SessionsClient.revokeUser` / `revokeRealmSessions`, ADR-080) — how many
 * sessions the revocation touched.
 */
export interface SessionRevokeResult {
  status: string;
  revoked: number;
}

/**
 * Response from `AdminUsersClient.delinkContact` (ADR-080 Part 2): the contact
 * whose provider binding was severed and how many active
 * `contact_verifications` rows were revoked. Defined locally (not pulled from
 * the bundled `@realm-id/sdk`) so the shape is correct regardless of the
 * vendored SDK's build state.
 */
export interface DelinkContactResult {
  status: string;
  contact_id: string;
  revoked_bindings: number;
}

/**
 * Response from `AdminUsersClient.handBack` (ADR-080 Part 3): the reactivated
 * account and the email identity moved onto it.
 */
export interface HandBackResult {
  status: string;
  user_id: string;
  email: string;
}

/**
 * Response from a drift-review reject (`AdminDriftReviewsClient.reject` /
 * `rejectHard`, ADR-080 Part 3). `mode` is `"soft"` (dismiss the asserted
 * change, keep the account + binding, notify) or `"hard"` (park the account by
 * severing its provider binding). `parked`/`revoked_bindings` are populated
 * only on a hard reject. Supersedes the pre-ADR-080 `{new_user_id,
 * original_value}` shape.
 */
export interface DriftRejectResult {
  id: string;
  status: string;
  mode: "soft" | "hard";
  parked?: boolean;
  revoked_bindings?: number;
}

/**
 * One enrolled MFA factor from `MfaClient.listAuthenticators` (ADR-080).
 * Today only TOTP is supported. `created_at`/`confirmed_at` are unix seconds
 * (`confirmed_at` is 0 until confirmed).
 */
export interface Authenticator {
  type: string;
  confirmed: boolean;
  created_at: number;
  confirmed_at: number;
}

/**
 * Response from `MfaClient.listAuthenticators`: the caller's enrolled
 * authenticator(s) plus how many backup/recovery codes remain unconsumed.
 */
export interface AuthenticatorList {
  authenticators: Authenticator[];
  backup_codes_remaining: number;
}

/**
 * Response from `MfaClient.regenerateRecoveryCodes`: the fresh one-time
 * recovery codes, shown once. The previous set is invalidated.
 */
export interface RecoveryCodes {
  status: string;
  recovery_codes: string[];
}

export interface PlatformNote {
  id: string;
  platform_id: string;
  author_user_id: string;
  body: string;
  created_at: number;
}

export interface RotateSigningKeyResponse {
  kid: string;
  retired_kids: string[];
}

export interface SuspendPlatformResponse {
  id: string;
  status: string;
  suspended_at?: number;
  reason?: string;
}

// ---- BFF aggregates ----

export interface BffSectionError {
  code: string;
  message: string;
  status: number;
}

export interface BffSection<T> {
  data?: T;
  error?: BffSectionError;
}

/**
 * Fleet rollup — `GET /admin/stats`, base-realm staff only (ADR-067: a
 * platform owner 403s here). Reached either directly (`admin.admin.stats()`)
 * or as the `stats` section of the BFF's `/home` aggregate, which is why it is
 * re-exported here rather than redeclared: this file used to carry a loose
 * `{[k: string]: unknown}` stand-in, and two structurally-different
 * `AdminStats` types then collided at any call site that mixed the two.
 * The single definition, with the v0.52.0 fleet fields and the
 * gauge-vs-flow semantics of `sessions_active` / `sessions_24h`, lives in
 * `@realm-id/sdk`.
 */
export type { AdminStats } from "@realm-id/sdk";
import type { AdminStats } from "@realm-id/sdk";

/**
 * MFA coverage as its raw parts so a UI can render "8 of 40" rather than a
 * bare rounded percentage.
 *
 * `percent` is `null` when `eligible_users === 0` — there is no coverage of
 * an empty population, and rendering 0% would read as "nobody has MFA".
 * Treat null as "—", never as zero.
 */
export interface MfaCoverage {
  covered_users: number;
  eligible_users: number;
  /** 0–100, one decimal place. Null when eligible_users === 0. */
  percent: number | null;
}

/**
 * Platform KPI rollup — `GET /platforms/{pid}/stats` (issuer v0.52.0),
 * gated on the ADR-074 `users:read` permission. Server-cached for 30s, so
 * a dashboard reload or a second tab is free but a just-enrolled user shows
 * up within half a minute.
 *
 * `sessions_24h` carries the same flow semantics as {@link AdminStats}.
 */
export interface PlatformStats {
  platform_id: string;
  /** Unix seconds the snapshot was computed (may be up to 30s stale). */
  generated_at: number;
  orgs_count: number;
  users_count: number;
  sessions_24h: number;
  mfa_coverage: MfaCoverage;
}

/** ADR-054 scheduled refresh-token expiry, as carried by the realm config. */
export interface RefreshAbsoluteExpiry {
  /** "rolling" (the default) or a scheduled-cutoff mode. */
  mode: string;
  /** "HH:MM" local wall-clock cutoff; empty when mode is rolling. */
  daily_cutoff_local: string;
  /** IANA zone the cutoff is evaluated in; empty when mode is rolling. */
  timezone: string;
  applies_to_service: boolean;
}

/**
 * Realm-level configuration — the mutable allowlist, shared by
 * `PATCH /platforms/{id}/config` (as a partial) and its read counterpart
 * `GET /platforms/{id}/config` (issuer v0.52.0).
 *
 * The key set is server-owned and drift-tested against the issuer's
 * `RealmConfigPatch`; `signup_mode` is deliberately ABSENT (it is per-org
 * tenant config, and PATCHing it here 400s on the allowlist).
 */
export interface RealmConfigPatch {
  // Sessions
  concurrent_session_limit?: number;
  session_eviction_policy?: "reject";
  access_ttl_seconds?: number;
  refresh_ttl_seconds?: number;
  challenge_ttl_seconds?: number;
  /**
   * ADR-070 idle timeout. 0 = disabled (default); when enabled the issuer
   * bounds it to [300, refresh_ttl_seconds] and 400s `invalid_config_value`.
   */
  idle_ttl_seconds?: number;
  max_user_session_lifetime_seconds?: number;
  refresh_absolute_expiry?: RefreshAbsoluteExpiry;
  // MFA
  mfa_session_ttl_seconds?: number;
  /** ADR-075 realm-wide floor; "enabled" is a UI hint with no server effect. */
  mfa_policy?: "disabled" | "enabled" | "enforced";
  otp_mfa_enabled?: boolean;
  /** ADR-078: an eligible provider MFA proof satisfies the GENERIC requirement. */
  accept_provider_mfa?: boolean;
  /** ADR-078 freshness window; 0 = the whole session (default). */
  provider_mfa_ttl_seconds?: number;
  // Login
  otp_login_enabled?: boolean;
  otp_length?: number;
  otp_ttl_seconds?: number;
  require_bff_login?: boolean;
  origin_enforcement?: string;
  // Tokens & SDK
  platform_token_ttl_seconds?: number;
  access_token_custom_claim_keys?: string[];
  service_refresh_rotates?: boolean;
  platform_refresh_rotates?: boolean;
  service_refresh_ttl_seconds?: number;
  service_refresh_ttl_max_seconds?: number;
  // Roster
  default_invitation_role?: string;
  // Signing keys
  signing_key_rotation_mode?: "auto" | "manual";
  signing_key_rotation_interval?: "1w" | "1mo" | "1y";
}

/**
 * The read projection of {@link RealmConfigPatch}. Unlike the patch, EVERY
 * key is always present — the zero value (`0`, `""`, `false`, `[]`) means
 * "unset / server default", not a configured zero. A UI priming its controls
 * should treat zero as empty rather than as an explicit choice.
 */
export type RealmConfigView = Omit<
  Required<RealmConfigPatch>,
  | "mfa_policy"
  | "session_eviction_policy"
  | "signing_key_rotation_mode"
  | "signing_key_rotation_interval"
> & {
  // Widened to plain strings on the READ side: the unset zero value is `""`,
  // which is not a member of the patch-side union. Narrow at the call site.
  mfa_policy: string;
  session_eviction_policy: string;
  signing_key_rotation_mode: string;
  signing_key_rotation_interval: string;
};

/** Response envelope of GET/PATCH `/platforms/{id}/config`. */
export interface RealmConfigResponse {
  id: string;
  config: RealmConfigView;
}

export interface AdminPlatformsResponse {
  items: Platform[];
  next_cursor?: string | null;
  total?: number;
}

export interface AuditEvent {
  [k: string]: unknown;
}

export interface AdminEventsResponse {
  items: AuditEvent[];
  next_cursor?: string | null;
}

export interface HomeResponse {
  mode: "ops" | "customer";
  stats?: BffSection<AdminStats>;
  platforms: BffSection<AdminPlatformsResponse>;
  events?: BffSection<AdminEventsResponse>;
}

export interface TenantFullResponse {
  tenant: BffSection<TenantSummary>;
  events: BffSection<AdminEventsResponse>;
}

// ---- /me + identity providers ----

export interface MeMembership {
  tenant_id: string;
  platform_id: string;
  display_name: string;
  role: string;
  /**
   * True for the base realm's admin tenant — the RealmID ops workspace, not a
   * user-facing platform. Set by the BFF (the issuer's /me is realm-agnostic);
   * absent/false for every membership on a partner-realm session. Admin UIs use
   * it to drop "RealmID" from the platform switcher and gate an ops/platform
   * view toggle. Optional for back-compat with pre-is_base BFFs.
   */
  is_base?: boolean;
}

export interface ProfileResponse {
  user_id: string;
  name: string;
  email: string;
  is_realm_staff: boolean;
  owned_platforms_count: number;
  memberships: MeMembership[];
}

export interface PublicIdentityProvider {
  type: string;
  client_id?: string;
  nickname?: string;
}

export interface PublicIdentityProviderResponse {
  tenant_id?: string | null;
  providers: PublicIdentityProvider[];
}

// ---- admin identity-provider CRUD (issuer `/identity-providers`, ADR-046) ----
//
// Distinct from the public lookup above: these carry the full admin row
// (ids, scope, enabled flag, origins) and are owner/realm-admin gated.
// No `client_secret` exists anywhere — RealmID stores only the public
// OAuth `client_id` by design.

export type IdpScope = "realm" | "tenant";
export type IdpClientType = "web" | "ios" | "android" | "desktop" | "other";

export interface AdminIdentityProvider {
  id: string;
  /** "realm" → platform-wide; "tenant" → a per-tenant override. */
  entity_type: IdpScope;
  /** The realm id (when realm-scoped) or tenant id (when tenant-scoped). */
  entity_id: string;
  /** Provider key. Only "google" verifies logins today (ADR-046). */
  provider: string;
  client_type: IdpClientType;
  client_id: string;
  /**
   * The `sources.id` this registration is bound to (ADR-072 § Amendment).
   * Empty/absent = legacy/unrestricted. App-first registration sets it so the
   * row's `client_id` is attributed to a specific app.
   */
  app_id?: string;
  allowed_origins: string[];
  comments: string;
  /** Provider-specific PUBLIC config (firebase web config); empty otherwise. */
  config?: Record<string, string>;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

export interface IdpCreateInput {
  /** Owning realm/platform id. Required by the issuer on every create. */
  platform_id: string;
  /** Present → tenant-scoped override; omit → realm-scoped (platform-wide). */
  tenant_id?: string;
  provider: string;
  client_type: IdpClientType;
  client_id: string;
  /**
   * Bind this registration to a human app (`sources.id`) so its `client_id` is
   * attributed to that app (ADR-072 § Amendment / app-first registration).
   * The issuer validates the source is a human app on the same platform.
   */
  app_id?: string;
  /** Required for `web` client_type; rejected for non-web. */
  allowed_origins?: string[];
  comments?: string;
  /** Provider-specific PUBLIC config — for firebase: apiKey/authDomain/appId. */
  config?: Record<string, string>;
}

/** Sparse update — only these fields are patchable on the issuer. */
export interface IdpPatchInput {
  enabled?: boolean;
  client_id?: string;
  /** Re-bind (or, with "", clear) this row's app binding (ADR-072 § Amendment). */
  app_id?: string;
  allowed_origins?: string[];
  comments?: string;
  config?: Record<string, string>;
}

export interface IdpListPage {
  items: AdminIdentityProvider[];
}
