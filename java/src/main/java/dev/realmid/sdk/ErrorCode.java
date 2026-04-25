package dev.realmid.sdk;

/**
 * Stable, machine-readable identifier for a verification failure.
 * Mirrors the VerifyErrorCode union in the TypeScript SDK and the
 * ErrorCode constants in the Go SDK.
 */
public enum ErrorCode {
    MALFORMED("malformed"),
    WRONG_ALGORITHM("wrong_algorithm"),
    BAD_SIGNATURE("bad_signature"),
    WRONG_ISSUER("wrong_issuer"),
    WRONG_AUDIENCE("wrong_audience"),
    EXPIRED("expired"),
    NOT_YET_VALID("not_yet_valid"),
    UNKNOWN_KID("unknown_kid"),
    JWKS_FETCH_FAILED("jwks_fetch_failed");

    private final String wire;

    ErrorCode(String wire) {
        this.wire = wire;
    }

    /** Wire value matching the TS / Go SDKs (e.g. "wrong_audience"). */
    public String wire() {
        return wire;
    }
}
