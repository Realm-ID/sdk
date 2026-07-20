package dev.realmid.sdk.auth;

/**
 * Request for
 * {@link AuthClient#regenerateRecoveryCodes(RegenerateRecoveryCodesRequest)}.
 *
 * <p>Current-user op (dual-mode bearer — exactly one of {@code userBearer} or
 * {@code userId}). Carries the bearer trio only; there is no request body. The
 * endpoint is step-up gated (RequireFresh): a token without a recent TOTP
 * yields {@code RealmException(mfa_required)} (412) until the user re-completes
 * TOTP. {@code onBehalfOfIp} is optional and only meaningful in BFF mode.
 */
public record RegenerateRecoveryCodesRequest(String userId, String userBearer, String onBehalfOfIp) {

    /** BFF mode: regenerate on behalf of {@code userId}. */
    public static RegenerateRecoveryCodesRequest forUser(String userId) {
        return new RegenerateRecoveryCodesRequest(userId, null, null);
    }

    /** Legacy mode: regenerate using the user's own access JWT. */
    public static RegenerateRecoveryCodesRequest withBearer(String userBearer) {
        return new RegenerateRecoveryCodesRequest(null, userBearer, null);
    }
}
