package dev.realmid.sdk.otp;

/**
 * Caller identity for {@link OtpClient#view(String, OtpViewOptions)} (SPEC §X.2).
 *
 * <p>Dual-mode bearer: provide EITHER {@code userBearer} OR {@code userId} (see
 * {@link OtpIssueRequest}). {@code onBehalfOfIp} is optional (BFF mode only).
 */
public record OtpViewOptions(String userId, String userBearer, String onBehalfOfIp) {

    public static OtpViewOptions empty() {
        return new OtpViewOptions(null, null, null);
    }

    /** Legacy mode: use the user's own access JWT as the bearer. */
    public static OtpViewOptions withBearer(String userBearer) {
        return new OtpViewOptions(null, userBearer, null);
    }

    /** BFF mode: act on behalf of {@code userId} via the platform token. */
    public static OtpViewOptions forUser(String userId) {
        return new OtpViewOptions(userId, null, null);
    }
}
