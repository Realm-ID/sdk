package dev.realmid.sdk.otp;

/**
 * Caller identity for {@link OtpClient#view(String, OtpViewOptions)} (SPEC §X.2).
 *
 * <p>Actor (R60): {@code userToken} rides in X-User-Token, or the realm carries one via {@code withUserToken}; {@code userId} is attribution only (see
 * {@link OtpIssueRequest}). {@code onBehalfOfIp} is optional (BFF mode only).
 */
public record OtpViewOptions(String userId, String userToken, String onBehalfOfIp) {

    /** Never prints a credential. */
    @Override
    public String toString() {
        return "OtpViewOptions[userId=" + userId + ", onBehalfOfIp=" + onBehalfOfIp + "]";
    }


    public static OtpViewOptions empty() {
        return new OtpViewOptions(null, null, null);
    }

    /** Per-call actor: the user's access JWT rides in X-User-Token (never as the bearer, R60). */
    public static OtpViewOptions withUserToken(String userToken) {
        return new OtpViewOptions(null, userToken, null);
    }

    /** BFF mode: act on behalf of {@code userId} via the platform token. */
    public static OtpViewOptions forUser(String userId) {
        return new OtpViewOptions(userId, null, null);
    }
}
