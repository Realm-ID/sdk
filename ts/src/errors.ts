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
  | "session_limit_reached"
  | "tenant_required"
  | "tenant_invalid"
  | "account_suspended"
  | "account_deactivated"
  | "realm_origin_mismatch"
  | "realm_mismatch"
  | "missing_origin"
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
  "provider_token_invalid", "mfa_required", "session_limit_reached",
  "tenant_required", "tenant_invalid", "account_suspended",
  "account_deactivated", "realm_origin_mismatch", "missing_origin",
  "refresh_invalid",
  "unauthorized", "forbidden", "not_found", "conflict", "rate_limited",
  "bad_request", "network", "server_error",
  "invalid_otp", "otp_expired", "otp_locked", "otp_not_found",
  "invalid_purpose", "invalid_subject_ref",
]);

export function isKnownCode(s: string | undefined): s is ErrorCode {
  return typeof s === "string" && KNOWN_CODES.has(s as ErrorCode);
}
