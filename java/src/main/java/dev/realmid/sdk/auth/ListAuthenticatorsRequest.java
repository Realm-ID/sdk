package dev.realmid.sdk.auth;

/**
 * Request for {@link AuthClient#listAuthenticators(ListAuthenticatorsRequest)}.
 *
 * <p>Current-user op (escort form, R60: the actor is {@code userToken} (sent in X-User-Token) or the
 * realm's {@code withUserToken}; {@code userId} is attribution only). No request body.
 * {@code onBehalfOfIp} is optional and only meaningful in BFF mode.
 */
public record ListAuthenticatorsRequest(String userId, String userToken, String onBehalfOfIp) {

    /** Never prints a credential. */
    @Override
    public String toString() {
        return "ListAuthenticatorsRequest[userId=" + userId + ", onBehalfOfIp=" + onBehalfOfIp + "]";
    }


    /** BFF mode: list on behalf of {@code userId}. */
    public static ListAuthenticatorsRequest forUser(String userId) {
        return new ListAuthenticatorsRequest(userId, null, null);
    }

    /** Per-call actor: list sending the user's own access JWT in X-User-Token. */
    public static ListAuthenticatorsRequest withUserToken(String userToken) {
        return new ListAuthenticatorsRequest(null, userToken, null);
    }
}
