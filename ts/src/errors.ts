/**
 * Unified error type for the Realm ID SDK. Every failure thrown from the SDK
 * is a `RealmError`. Callers branch on `error.code` (a stable identifier from
 * the taxonomy in SPEC §3.1) and read details from `error.details` when the
 * server attached envelope siblings (e.g. `mfa_challenge_token`).
 */

export type ErrorCode =
  // verifier
  | "malformed"
  | "invalid_config"
  | "wrong_algorithm"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "expired"
  | "not_yet_valid"
  | "unknown_kid"
  | "jwks_fetch_failed"
  // auth-flow
  | "provider_token_invalid"
  | "mfa_required"
  // `mfa_registration_required` (412) is the first-factor-ENROLLMENT variant of
  // the MFA gate: the realm/tenant requires MFA and the user has no confirmed
  // factor yet, so the remedy is an enrollment screen, not a code prompt. Go
  // has carried it since ADR-061; ts and Java did not, so it collapsed into the
  // generic 412 mapping and the distinction was lost for exactly the clients
  // that must render a different screen.
  | "mfa_registration_required"
  | "session_limit_reached"
  | "tenant_required"
  | "tenant_invalid"
  | "account_suspended"
  | "account_deactivated"
  // `contact_admin_required` (409) — POST /auth/login refuses to silently link
  // a DIFFERENT provider identity to an email/phone already bound to an
  // existing account (ADR-080 Part 2). An owner must delink first.
  | "contact_admin_required"
  | "realm_origin_mismatch"
  | "realm_mismatch"
  | "missing_origin"
  // ADR-097 — the `scope` intake on POST /auth/token (SPEC §11). These are the
  // issuer's REFUSALS; `insufficient_scope`, the 403 an SDK route gate emits,
  // is deliberately absent because no issuer handler produces it and a taxonomy
  // entry with no producer is a phantom.
  //
  // `invalid_scope` — a scope entry is not an RFC 6749 §3.3 scope-token.
  // Refused rather than reshaped: a SPACE inside a value would split one scope
  // into two, silently changing the authority granted.
  | "invalid_scope"
  // `too_many_scopes` / `scope_too_long` — over the realm's
  // user_api_keys.max_permission_strings / max_permission_string_len. Refused
  // at mint rather than handed back as a token that dies at the next hop with
  // an opaque proxy error.
  | "too_many_scopes"
  | "scope_too_long"
  // `scope_not_supported` — this session class mints no `scope` (a
  // service-class refresh). Refused rather than ignored: a field that is
  // sendable and enforced nowhere reads as working.
  | "scope_not_supported"
  // `reserved_claim_key` — a `custom_claims` key collides with a reserved JWT
  // claim name. Previously dropped silently; refused from ADR-097 D3, because a
  // dropped claim is indistinguishable from an honoured one on your side.
  | "reserved_claim_key"
  // `realmid_audience_immutable` — a scope rename against a `realmid`-audience
  // realm, whose vocabulary is RealmID's own validated catalog.
  | "realmid_audience_immutable"
  // `invalid_rename` — `to` equals `from`.
  | "invalid_rename"
  // `refresh_invalid` is returned by POST /auth/token (surfaced by
  // `auth.token()` / the TokenManager) when the presented refresh token is
  // expired, revoked, or reuse-detected — terminal for the caller, no
  // retry will help. Distinct from a generic `unauthorized` so long-lived
  // clients can deterministically branch on "re-authentication required"
  // versus a transient 401. The SDK does not subdivide
  // expiry/revocation/reuse: all three collapse to `refresh_invalid`
  // (the issuer does not distinguish them on the wire). SPEC §3.1.
  | "refresh_invalid"
  // `token_stale` (401, ADR-107 D10) comes from the VERIFIER, not the issuer:
  // the access token was minted before the subject's authority changed, so its
  // `role`/`scope`/`product_roles` no longer describe them. The remedy is a
  // SINGLE refresh, which the client SDK performs transparently.
  //
  // Distinct from `unauthorized` and `refresh_invalid` for the reason
  // `refresh_invalid` itself exists: a client that collapses every 401 into
  // "sign the user out" would sign people out on PROMOTION — on a grant that
  // just widened their access. Branch on this code BEFORE any generic 401
  // handling.
  | "token_stale"
  // `user_suspended` (403, issuer ADR-104 R-d): the subject's row in THAT org is
  // suspended or deactivated. Not a sign-out; the person may be active elsewhere.
  | "user_suspended"
  // `tenant_disabled` (403, issuer swagger 0.59.0): the org the token is for (or, on
  // login/refresh, the org explicitly requested) is suspended or deactivated. The
  // session is NOT ended: pick another org, or wait for this one to be reactivated.
  // Distinct from `user_suspended` (the end user's own row).
  | "tenant_disabled"
  // `escort_suspended` (403 from the issuer, ADR-104 R-d): the BFF's own /auth/*
  // escort account is disabled. A service problem, not the user's.
  | "escort_suspended"
  // `last_owner` (409) comes from BOTH owner-protection paths: changing the
  // owner's role, and DEACTIVATING the owner. Transfer ownership first
  // (ADR-076).
  //
  // Registered 2026-09-04 after a partner reported their error mapper "had no
  // last_owner case" — because the SDK never gave them one. Two doc comments
  // promised it by name while no taxonomy declared it, so it arrived as a
  // generic `conflict` in every language.
  //
  // ⚠️ Only `deactivated` is guarded. SUSPENDING the sole owner succeeds by
  // design, so a tenant can be left with a suspended owner and no admin.
  | "last_owner"
  // partner OTP primitive
  | "invalid_otp"
  | "otp_expired"
  | "otp_locked"
  | "otp_not_found"
  | "invalid_purpose"
  | "invalid_subject_ref"
  // service accounts (ADR-071) + sources (ADR-072)
  | "handle_taken"
  | "invalid_role"
  | "service_account_not_found"
  | "not_service"
  | "method_violates_kind"
  | "source_not_found"
  | "user_not_found"
  // platform-scoped 404s. `platform_not_found` is what the issuer answers on
  // every by-id platform route (16 call sites). It is registered for the same
  // reason as the six sibling `*_not_found` codes above: without it the code
  // falls back to `statusToCode(404)` and the caller cannot tell "no such
  // platform" from any other 404 on the request. It NEVER distinguishes "not
  // yours" from "never existed" — the issuer answers both identically on
  // purpose (v0.78.0 oracle rule), and that is a security property, not a
  // taxonomy one.
  | "platform_not_found"
  // cross-realm integrations (ADR-082/083)
  | "slug_taken"
  | "integration_not_found"
  | "already_installed"
  // `role_not_service_typed` / `role_not_installable` are RETAINED but DEAD:
  // the issuer has emitted neither since ADR-101 D7 replaced the installed
  // role with a stated permission list. Kept so existing `error.code ===`
  // branches still type-check; they can no longer arrive from a current
  // issuer. Match the three permission codes below instead.
  | "role_not_service_typed"
  | "role_not_installable"
  // ADR-101 D7 install refusals — the stated-permission replacement for the
  // role-based install. `permissions_required` (400) is what a client still
  // sending the retired `role_id` body gets back: no permission was named, and
  // an install granting nothing can authorise no call. `unknown_permission`
  // (400) is an entry outside the ADR-074 catalog — a typo would otherwise
  // store INERT, reading as configured while enforcing nothing.
  // `permissions_exceed_grantor` (403) is the "you cannot grant authority you
  // do not hold" rule; the tenant owner is implicit-all and never sees it.
  | "permissions_required"
  | "unknown_permission"
  | "permissions_exceed_grantor"
  // `install_grants_nothing` (403) is raised at MINT, not install: the
  // installation row states no permissions and can authorise nothing.
  | "install_grants_nothing"
  // Pagination input validation (400). Deliberately TWO codes: the caller's
  // correction differs — `invalid_cursor` means RESTART THE WALK (non-numeric,
  // signed, or past the max offset), `invalid_limit` means FIX YOUR CONSTANT
  // (non-numeric or <= 0). Neither fires on the ordinary cases: a well-formed
  // cursor past the end still returns an empty last page, and a limit ABOVE the
  // maximum CLAMPS rather than rejecting.
  | "invalid_cursor"
  | "invalid_limit"
  | "installation_not_found"
  | "installation_revoked"
  | "role_unavailable"
  | "key_class_mismatch"
  // membership self-service (ADR-092 D5). Registered so the specific code
  // reaches `error.code` instead of collapsing into the generic 409
  // `conflict` — each has a distinct remedy and they are indistinguishable
  // by status alone. `owner_cannot_be_revoked` and `owner_cannot_leave` are
  // the same rule (`tenants.owner_user_id` is NOT NULL) on two routes: both
  // are answered by an ADR-076 ownership transfer, never by a retry.
  | "owner_cannot_be_revoked"
  // `membership_not_found` (404) is the self-service routes' refusal when the
  // caller has no reachable membership in the named org — emitted at three
  // sites in the issuer's `me_memberships.go`. It NEVER distinguishes "not
  // yours" from "never existed"; both answer identically on purpose, the same
  // oracle rule `platform_not_found` carries.
  //
  // Registered because `MembershipActionCode` (memberships.ts) already listed
  // it while the ErrorCode taxonomy did not, so the code a caller was told to
  // branch on arrived as a generic `not_found` from every SDK.
  | "membership_not_found"
  | "single_tenant_not_required"
  | "not_invited"
  | "not_pending"
  | "invitations_unavailable"
  | "owner_cannot_leave"
  | "already_left"
  // password credentials (SPEC §3.1; ADR-104 amendment + ADR-111, issuer spec
  // 0.53.0). `password_must_change`, `password_too_short` and `password_too_long`
  // are deliberately NOT registered: they predate this and arrive as
  // `details.server_code`.
  | "password_unchanged"
  | "password_change_not_required"
  | "reset_link_required"
  | "verified_email_required"
  | "no_verified_email"
  | "reset_throttled"
  | "reset_token_invalid"
  | "reset_token_expired"
  | "reset_token_used"
  | "reset_token_superseded"
  // phone-delivery channels (SPEC §3.1; ADR-115, issuer spec 0.60.0), all new to
  // the wire in that spec. `delivery_unavailable` is deliberately NOT registered:
  // it has shipped since ADR-103 and arrives as `details.server_code`, so
  // registering it would move it. Its new `channel` lands in `details.channel`.
  | "invalid_channel_config"
  | "channel_validation_failed"
  | "channel_not_configured"
  | "phone_otp_rate_limited"
  // sign-in code send (SPEC §3.1; ADR-116, issuer spec 0.61.0). `sign_in_ip_rate_limited`
  // and `invalid_on_behalf_of_ip` are new to the wire. `method_not_enabled` is
  // registered although it already ships (400 on the ADR-094 domain-SSO routes, where
  // it arrived as `details.server_code`): a BEHAVIOUR CHANGE, owner ruling 2026-10-18.
  // `delivery_unavailable` stays unregistered; see isDeliveryUnavailable.
  | "sign_in_ip_rate_limited"
  | "method_not_enabled"
  | "invalid_on_behalf_of_ip"
  // management / generic
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "bad_request"
  | "network"
  | "server_error";

export interface RealmErrorOptions {
  code: ErrorCode;
  message: string;
  httpStatus?: number;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class RealmError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus?: number;
  readonly details?: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(opts: RealmErrorOptions) {
    super(opts.message);
    this.name = "RealmError";
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.details = opts.details;
    this.cause = opts.cause;
  }
}

/**
 * `auth.token`'s give-up after it was handed over to a newer refresh token more
 * times than it follows (SPEC §4.2, go `0.64.2`): a retryable 503 `server_error`
 * (it IS a {@link RealmError}) that carries the newest LIVE refresh token for
 * the caller's next attempt.
 *
 * The token is a credential, so it lives in a `#private` field behind
 * {@link RefreshSupersededError.refreshToken}: it is absent from `message`,
 * `String(e)`, `JSON.stringify(e)`, `util.inspect` (including `showHidden`) and
 * the stack, which is everything a logger reaches.
 */
export class RefreshSupersededError extends RealmError {
  readonly #refreshToken: string;

  constructor(refreshToken: string) {
    super({ code: "server_error", message: "refresh superseded, retry", httpStatus: 503 });
    this.name = "RefreshSupersededError";
    this.#refreshToken = refreshToken;
  }

  /** The newest live refresh token; present it on the next call. */
  refreshToken(): string {
    return this.#refreshToken;
  }
}

/**
 * True when `e` is the ADR-107 staleness refusal: the token was minted before
 * its subject's authority changed. The caller's move is ONE refresh + replay —
 * and, if the replay fails the same way on a token minted after that refresh, a
 * hard failure rather than a second refresh (D13).
 *
 * Check this BEFORE any generic 401 handling. `token_stale` carries a 401, so a
 * caller that tests the general condition first will tear down a session that
 * only needed a refresh — and on PROMOTION it would sign the user out of a
 * grant that just widened their access.
 */
export function isTokenStale(e: unknown): boolean {
  return e instanceof RealmError && e.code === "token_stale";
}

/** True when `e` is the issuer's 403 `user_suspended` (ADR-104 R-d). */
export function isUserSuspended(e: unknown): boolean {
  return e instanceof RealmError && e.code === "user_suspended";
}

/** True when `e` is the issuer's 403 `tenant_disabled` (org suspended/deactivated; session NOT ended). */
export function isTenantDisabled(e: unknown): boolean {
  return e instanceof RealmError && e.code === "tenant_disabled";
}

/** True when `e` is the issuer's 403 `escort_suspended` (ADR-104 R-d). */
export function isEscortSuspended(e: unknown): boolean {
  return e instanceof RealmError && e.code === "escort_suspended";
}

/** True when `e` is the issuer's 400 `invalid_channel_config` (a messaging save broke a shape rule; the message names the field). */
export function isInvalidChannelConfig(e: unknown): boolean {
  return e instanceof RealmError && e.code === "invalid_channel_config";
}

/** True when `e` is the issuer's 422 `channel_validation_failed` (the provider refused the credentials; nothing was stored). */
export function isChannelValidationFailed(e: unknown): boolean {
  return e instanceof RealmError && e.code === "channel_validation_failed";
}

/** True when `e` is the issuer's 404 `channel_not_configured` (the realm saved nothing for that channel). */
export function isChannelNotConfigured(e: unknown): boolean {
  return e instanceof RealmError && e.code === "channel_not_configured";
}

/**
 * True when `e` is the issuer's 429 `phone_otp_rate_limited` (this number was
 * sent the realm's limit of phone codes within the window). The wait is the
 * `Retry-After` header, which this SDK does not surface.
 */
export function isPhoneOtpRateLimited(e: unknown): boolean {
  return e instanceof RealmError && e.code === "phone_otp_rate_limited";
}

/**
 * True when `e` is the issuer's 429 `sign_in_ip_rate_limited` (this end user's
 * IP, the `onBehalfOfIp` passed to `sendLoginCode`, used the realm's
 * `phone_otp.sign_in_per_ip_per_hour`).
 */
export function isSignInIpRateLimited(e: unknown): boolean {
  return e instanceof RealmError && e.code === "sign_in_ip_rate_limited";
}

/**
 * True when `e` is the issuer's 503 `delivery_unavailable` (the realm has no
 * working channel for the requested delivery mode; `details.channel` names it).
 * The code is NOT registered, so it arrives as `details.server_code`; this
 * checks both places and keeps working if the code is registered later.
 */
export function isDeliveryUnavailable(e: unknown): boolean {
  if (!(e instanceof RealmError)) return false;
  return (e.code as string) === "delivery_unavailable" || e.details?.["server_code"] === "delivery_unavailable";
}

/**
 * Map an HTTP status code to a fallback ErrorCode when the server response
 * does not carry an explicit `code` field.
 */
export function statusToCode(status: number): ErrorCode {
  if (status === 400) return "bad_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 412) return "bad_request"; // overridden by server `code`
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "bad_request";
}

const KNOWN_CODES = new Set<ErrorCode>([
  "invalid_config", // ts-only: createRealm without sessionStore (SPEC §6.7.5; Go/Java use their own forms)
  "malformed", "wrong_algorithm", "bad_signature", "wrong_issuer",
  "wrong_audience", "expired", "not_yet_valid", "unknown_kid",
  "jwks_fetch_failed",
  "provider_token_invalid", "mfa_required", "mfa_registration_required",
  "session_limit_reached",
  "tenant_required", "tenant_invalid", "account_suspended",
  "account_deactivated", "contact_admin_required",
  "realm_origin_mismatch", "realm_mismatch",
  "missing_origin", "refresh_invalid", "token_stale", "last_owner",
  "user_suspended", "escort_suspended", "tenant_disabled",
  "invalid_scope", "too_many_scopes", "scope_too_long", "scope_not_supported",
  "reserved_claim_key", "realmid_audience_immutable", "invalid_rename",
  "unauthorized", "forbidden", "not_found", "conflict", "rate_limited",
  "bad_request", "network", "server_error",
  "invalid_otp", "otp_expired", "otp_locked", "otp_not_found",
  "invalid_purpose", "invalid_subject_ref",
  "handle_taken", "invalid_role", "service_account_not_found",
  "not_service", "method_violates_kind", "source_not_found", "user_not_found",
  "platform_not_found",
  "slug_taken", "integration_not_found", "already_installed",
  "role_not_service_typed", "role_not_installable",
  "permissions_required", "unknown_permission", "permissions_exceed_grantor",
  "install_grants_nothing",
  "invalid_cursor", "invalid_limit",
  "installation_not_found",
  "installation_revoked", "role_unavailable", "key_class_mismatch",
  "owner_cannot_be_revoked", "membership_not_found",
  "single_tenant_not_required", "not_invited",
  "not_pending", "invitations_unavailable", "owner_cannot_leave", "already_left",
  "password_unchanged", "password_change_not_required", "reset_link_required",
  "verified_email_required", "no_verified_email", "reset_throttled",
  "reset_token_invalid", "reset_token_expired", "reset_token_used", "reset_token_superseded",
  "invalid_channel_config", "channel_validation_failed", "channel_not_configured",
  "phone_otp_rate_limited",
  "sign_in_ip_rate_limited", "method_not_enabled", "invalid_on_behalf_of_ip",
]);

export function isKnownCode(s: string | undefined): s is ErrorCode {
  return typeof s === "string" && KNOWN_CODES.has(s as ErrorCode);
}

/**
 * Every code in the SPEC §3.1 taxonomy, as VALUES rather than a type.
 *
 * Exists so a downstream package never has to hand-copy the list. `web-admin`
 * kept its own `KNOWN_CODES` of 33 entries against a union of 76, so 43 server
 * codes fell through to the HTTP-status fallback and the specific remedy was
 * lost for exactly the callers the taxonomy exists to serve. A hand-maintained
 * subject list stops covering its subject silently; this export is the subject.
 *
 * `KNOWN_CODES` and the `ErrorCode` union are still two lists in THIS file, but
 * they cannot disagree: `scripts/taxonomy-parity.py` reads both out of the
 * source on every `make check` and fails on any difference in either direction.
 */
export const ERROR_CODES: readonly ErrorCode[] = Object.freeze([...KNOWN_CODES]);
