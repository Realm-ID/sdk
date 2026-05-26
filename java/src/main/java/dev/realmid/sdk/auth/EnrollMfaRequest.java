package dev.realmid.sdk.auth;

/**
 * Request for {@link AuthClient#enrollMfa(EnrollMfaRequest)}.
 *
 * <p>Current-user op (dual-mode bearer). Provide EITHER {@code userBearer}
 * (the user's own access JWT, legacy mode) OR {@code userId} (BFF mode, the
 * SDK sends the platform token + {@code X-On-Behalf-Of-User} header). Set at
 * most one. {@code onBehalfOfIp} is optional and only meaningful in BFF mode.
 *
 * <p>{@code method} is optional; when null/empty it is omitted from the wire
 * and the server defaults to {@code "totp"}.
 */
public record EnrollMfaRequest(String userId, String userBearer, String onBehalfOfIp, String method) {

    /** BFF mode: act on behalf of {@code userId} via the platform token. */
    public static EnrollMfaRequest forUser(String userId) {
        return new EnrollMfaRequest(userId, null, null, null);
    }

    /** Legacy mode: use the user's own access JWT as the bearer. */
    public static EnrollMfaRequest withBearer(String userBearer) {
        return new EnrollMfaRequest(null, userBearer, null, null);
    }
}
