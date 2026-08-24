/**
 * Unified error type for the Realm ID SDK. Every failure thrown from the SDK
 * is a `RealmError`. Callers branch on `error.code` (a stable identifier from
 * the taxonomy in SPEC §3.1) and read details from `error.details` when the
 * server attached envelope siblings (e.g. `mfa_challenge_token`).
 */

export type ErrorCode =
  // verifier
  | "malformed"
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
  | "role_not_service_typed"
  | "role_not_installable"
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
  | "single_tenant_not_required"
  | "not_invited"
  | "not_pending"
  | "invitations_unavailable"
  | "owner_cannot_leave"
  | "already_left"
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
  "malformed", "wrong_algorithm", "bad_signature", "wrong_issuer",
  "wrong_audience", "expired", "not_yet_valid", "unknown_kid",
  "jwks_fetch_failed",
  "provider_token_invalid", "mfa_required", "mfa_registration_required",
  "session_limit_reached",
  "tenant_required", "tenant_invalid", "account_suspended",
  "account_deactivated", "contact_admin_required",
  "realm_origin_mismatch", "realm_mismatch",
  "missing_origin", "refresh_invalid",
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
  "role_not_service_typed", "role_not_installable", "installation_not_found",
  "installation_revoked", "role_unavailable", "key_class_mismatch",
  "owner_cannot_be_revoked", "single_tenant_not_required", "not_invited",
  "not_pending", "invitations_unavailable", "owner_cannot_leave", "already_left",
]);

export function isKnownCode(s: string | undefined): s is ErrorCode {
  return typeof s === "string" && KNOWN_CODES.has(s as ErrorCode);
}
