package dev.realmid.sdk.auth;

/**
 * Request for {@link AuthClient#listAuthenticators(ListAuthenticatorsRequest)}.
 *
 * <p>Current-user op (dual-mode bearer — exactly one of {@code userBearer} or
 * {@code userId}). Carries the bearer trio only; there is no request body.
 * {@code onBehalfOfIp} is optional and only meaningful in BFF mode.
 */
public record ListAuthenticatorsRequest(String userId, String userBearer, String onBehalfOfIp) {

    /** BFF mode: list on behalf of {@code userId}. */
    public static ListAuthenticatorsRequest forUser(String userId) {
        return new ListAuthenticatorsRequest(userId, null, null);
    }

    /** Legacy mode: list using the user's own access JWT. */
    public static ListAuthenticatorsRequest withBearer(String userBearer) {
        return new ListAuthenticatorsRequest(null, userBearer, null);
    }
}
