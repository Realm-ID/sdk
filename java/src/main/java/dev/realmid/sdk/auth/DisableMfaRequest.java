package dev.realmid.sdk.auth;

/**
 * Request for {@link AuthClient#disableMfa(DisableMfaRequest)}.
 *
 * <p>Current-user op (escort form, R60: the actor is {@code userToken} (sent in X-User-Token) or the
 * {@code userId}). {@code code} (the TOTP step-up) is required and travels in the body of the
 * {@code DELETE /auth/mfa} request.
 */
public record DisableMfaRequest(String userId, String userToken, String onBehalfOfIp, String code) {

    /** Never prints a credential. */
    @Override
    public String toString() {
        return "DisableMfaRequest[userId=" + userId + ", onBehalfOfIp=" + onBehalfOfIp + "]";
    }


    /** BFF mode: disable on behalf of {@code userId} with the given TOTP code. */
    public static DisableMfaRequest forUser(String userId, String code) {
        return new DisableMfaRequest(userId, null, null, code);
    }

    /** Per-call actor: disable sending the user's own access JWT in X-User-Token and TOTP code. */
    public static DisableMfaRequest withUserToken(String userToken, String code) {
        return new DisableMfaRequest(null, userToken, null, code);
    }
}
