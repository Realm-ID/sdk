package dev.realmid.sdk;

/**
 * Stable, machine-readable identifier for any SDK failure. Mirrors the
 * ErrorCode union in the TypeScript SDK and the constants in the Go SDK
 * (SPEC §3.1).
 */
public enum ErrorCode {
    // verifier
    MALFORMED("malformed"),
    WRONG_ALGORITHM("wrong_algorithm"),
    BAD_SIGNATURE("bad_signature"),
    WRONG_ISSUER("wrong_issuer"),
    WRONG_AUDIENCE("wrong_audience"),
    EXPIRED("expired"),
    NOT_YET_VALID("not_yet_valid"),
    UNKNOWN_KID("unknown_kid"),
    JWKS_FETCH_FAILED("jwks_fetch_failed"),

    // auth-flow
    PROVIDER_TOKEN_INVALID("provider_token_invalid"),
    MFA_REQUIRED("mfa_required"),
    SESSION_LIMIT_REACHED("session_limit_reached"),
    TENANT_REQUIRED("tenant_required"),
    TENANT_INVALID("tenant_invalid"),
    ACCOUNT_SUSPENDED("account_suspended"),
    ACCOUNT_DEACTIVATED("account_deactivated"),
    REALM_ORIGIN_MISMATCH("realm_origin_mismatch"),
    /**
     * ADR-041 client-side realm pin: the SDK was constructed for realm A
     * but the platform access token's {@code iss} references realm B (a
     * confused-deputy guard). Emitted locally before any subsequent API
     * call — never a server code on the partner surface (SPEC §3.1). The
     * Java SDK does not yet perform this client-side pin (Go/TS do); the
     * constant is present for cross-language taxonomy parity.
     */
    REALM_MISMATCH("realm_mismatch"),
    MISSING_ORIGIN("missing_origin"),
    /**
     * Returned by {@code POST /auth/token} when the presented refresh token is
     * expired, revoked, or reuse-detected — terminal for the caller (no retry
     * will help). Distinct from the generic {@link #UNAUTHORIZED} so long-lived
     * clients (the {@code TokenManager}, SPEC §4.2.1) can deterministically
     * branch on "re-authentication required" versus a transient 401. The SDK
     * does not subdivide expiry/revocation/reuse — all three collapse here, as
     * the issuer does not distinguish them on the wire (SPEC §3.1).
     */
    REFRESH_INVALID("refresh_invalid"),

    // partner OTP primitive (SPEC §X)
    INVALID_OTP("invalid_otp"),
    OTP_EXPIRED("otp_expired"),
    OTP_LOCKED("otp_locked"),
    OTP_NOT_FOUND("otp_not_found"),
    INVALID_PURPOSE("invalid_purpose"),
    INVALID_SUBJECT_REF("invalid_subject_ref"),

    // management / generic
    UNAUTHORIZED("unauthorized"),
    FORBIDDEN("forbidden"),
    NOT_FOUND("not_found"),
    CONFLICT("conflict"),
    RATE_LIMITED("rate_limited"),
    BAD_REQUEST("bad_request"),
    NETWORK("network"),
    SERVER_ERROR("server_error");

    private final String wire;

    ErrorCode(String wire) {
        this.wire = wire;
    }

    /** Wire form, matches TS / Go SDK. */
    public String wire() {
        return wire;
    }

    /** Look up an ErrorCode by its wire string, or null if unknown. */
    public static ErrorCode fromWire(String s) {
        if (s == null) return null;
        for (ErrorCode c : values()) {
            if (c.wire.equals(s)) return c;
        }
        return null;
    }

    /** Fallback when the server doesn't carry an explicit code. */
    public static ErrorCode fromHttpStatus(int status) {
        if (status == 400) return BAD_REQUEST;
        if (status == 401) return UNAUTHORIZED;
        if (status == 403) return FORBIDDEN;
        if (status == 404) return NOT_FOUND;
        if (status == 409) return CONFLICT;
        if (status == 412) return BAD_REQUEST;
        if (status == 429) return RATE_LIMITED;
        if (status >= 500) return SERVER_ERROR;
        return BAD_REQUEST;
    }
}
