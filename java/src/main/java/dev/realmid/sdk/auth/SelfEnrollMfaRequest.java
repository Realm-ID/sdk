package dev.realmid.sdk.auth;

/**
 * Request for {@link AuthClient#enrollMfa(SelfEnrollMfaRequest)} (ADR-061,
 * first-login MFA self-enrollment).
 *
 * <p>Refresh-authed: {@code refreshToken} is the handle to the user's login
 * session — the only credential a first-login user holds, since the MFA gate
 * withholds the access token. {@code tenantId} scopes the returned
 * enroll-challenge to the MFA-required tenant. In BFF mode the SDK's platform
 * token rides as the Authorization bearer and the refresh travels in the body
 * (exactly like {@code /auth/token}).
 *
 * <p>{@code method} is optional; when null/empty it is omitted from the wire
 * and the server defaults to {@code "totp"}. {@code origin} is an optional
 * per-call Origin override.
 */
public record SelfEnrollMfaRequest(String refreshToken, String tenantId, String method, String origin) {

    /** Enroll the user behind {@code refreshToken} in the default ("totp") method. */
    public static SelfEnrollMfaRequest of(String refreshToken, String tenantId) {
        return new SelfEnrollMfaRequest(refreshToken, tenantId, null, null);
    }

    /** Enroll with an explicit {@code method}. */
    public static SelfEnrollMfaRequest of(String refreshToken, String tenantId, String method) {
        return new SelfEnrollMfaRequest(refreshToken, tenantId, method, null);
    }
}
