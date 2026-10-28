package dev.realmid.sdk.auth;

/**
 * Request for {@link AuthClient#revokeAllSessions(RevokeAllSessionsRequest)}.
 *
 * <p>Current-user op (escort form, R60: the actor is {@code userToken} (sent in X-User-Token) or the
 * realm's {@code withUserToken}; {@code userId} is attribution only). No request body.
 */
public record RevokeAllSessionsRequest(String userId, String userToken, String onBehalfOfIp) {

    /** Never prints a credential. */
    @Override
    public String toString() {
        return "RevokeAllSessionsRequest[userId=" + userId + ", onBehalfOfIp=" + onBehalfOfIp + "]";
    }


    /** BFF mode: revoke all sessions on behalf of {@code userId}. */
    public static RevokeAllSessionsRequest forUser(String userId) {
        return new RevokeAllSessionsRequest(userId, null, null);
    }

    /** Per-call actor: revoke all sessions sending the user's own access JWT in X-User-Token. */
    public static RevokeAllSessionsRequest withUserToken(String userToken) {
        return new RevokeAllSessionsRequest(null, userToken, null);
    }
}
