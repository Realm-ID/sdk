package dev.realmid.sdk.auth;

/**
 * @param refreshToken the token to revoke; null/empty uses the caller's
 *                     cookie / current session server-side
 * @param origin       optional Origin header override
 * @param accessToken  optional. When set AND a
 *                     {@link dev.realmid.sdk.revocation.RevocationCache} is
 *                     configured on the Realm, the access token's {@code jti}
 *                     is pushed to the cache on a successful logout — bridging
 *                     the gap between logout and the token's stateless natural
 *                     expiry (ADR-041). Failing to push does NOT fail the
 *                     logout: the server-side refresh revocation is the
 *                     load-bearing operation and has already happened.
 */
public record LogoutRequest(String refreshToken, String origin, String accessToken) {
    public LogoutRequest(String refreshToken, String origin) { this(refreshToken, origin, null); }
    public static LogoutRequest empty() { return new LogoutRequest(null, null, null); }
    public static LogoutRequest of(String refreshToken) { return new LogoutRequest(refreshToken, null, null); }
    /** Revoke the refresh token AND deny the access token's jti locally. */
    public static LogoutRequest of(String refreshToken, String accessToken) {
        return new LogoutRequest(refreshToken, null, accessToken);
    }
}
