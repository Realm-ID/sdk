package dev.realmid.sdk.auth;

/**
 * Request for {@link AuthClient#revokeAllSessions(RevokeAllSessionsRequest)}.
 *
 * <p>Current-user op (dual-mode bearer — see {@link EnrollMfaRequest}).
 * Carries only the bearer trio; there is no request body.
 */
public record RevokeAllSessionsRequest(String userId, String userBearer, String onBehalfOfIp) {

    /** BFF mode: revoke all sessions on behalf of {@code userId}. */
    public static RevokeAllSessionsRequest forUser(String userId) {
        return new RevokeAllSessionsRequest(userId, null, null);
    }

    /** Legacy mode: revoke all sessions using the user's own access JWT. */
    public static RevokeAllSessionsRequest withBearer(String userBearer) {
        return new RevokeAllSessionsRequest(null, userBearer, null);
    }
}
