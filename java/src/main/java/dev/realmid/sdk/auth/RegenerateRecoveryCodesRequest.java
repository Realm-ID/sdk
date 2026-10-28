package dev.realmid.sdk.auth;

/**
 * Request for
 * {@link AuthClient#regenerateRecoveryCodes(RegenerateRecoveryCodesRequest)}.
 *
 * <p>Current-user op (escort form, R60: the actor is {@code userToken} (sent in X-User-Token) or the
 * realm's {@code withUserToken}; {@code userId} is attribution only). No request body. The
 * endpoint is step-up gated (RequireFresh): a token without a recent TOTP
 * yields {@code RealmException(mfa_required)} (412) until the user re-completes
 * TOTP. {@code onBehalfOfIp} is optional and only meaningful in BFF mode.
 */
public record RegenerateRecoveryCodesRequest(String userId, String userToken, String onBehalfOfIp) {

    /** Never prints a credential. */
    @Override
    public String toString() {
        return "RegenerateRecoveryCodesRequest[userId=" + userId + ", onBehalfOfIp=" + onBehalfOfIp + "]";
    }


    /** BFF mode: regenerate on behalf of {@code userId}. */
    public static RegenerateRecoveryCodesRequest forUser(String userId) {
        return new RegenerateRecoveryCodesRequest(userId, null, null);
    }

    /** Per-call actor: regenerate sending the user's own access JWT in X-User-Token. */
    public static RegenerateRecoveryCodesRequest withUserToken(String userToken) {
        return new RegenerateRecoveryCodesRequest(null, userToken, null);
    }
}
