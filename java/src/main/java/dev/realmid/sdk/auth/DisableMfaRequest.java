package dev.realmid.sdk.auth;

/**
 * Request for {@link AuthClient#disableMfa(DisableMfaRequest)}.
 *
 * <p>Current-user op (dual-mode bearer — see {@link EnrollMfaRequest}).
 * {@code code} (the TOTP step-up) is required and travels in the body of the
 * {@code DELETE /auth/mfa} request.
 */
public record DisableMfaRequest(String userId, String userBearer, String onBehalfOfIp, String code) {

    /** BFF mode: disable on behalf of {@code userId} with the given TOTP code. */
    public static DisableMfaRequest forUser(String userId, String code) {
        return new DisableMfaRequest(userId, null, null, code);
    }

    /** Legacy mode: disable using the user's own access JWT and TOTP code. */
    public static DisableMfaRequest withBearer(String userBearer, String code) {
        return new DisableMfaRequest(null, userBearer, null, code);
    }
}
