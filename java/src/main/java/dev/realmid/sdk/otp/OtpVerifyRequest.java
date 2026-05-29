package dev.realmid.sdk.otp;

/**
 * Request for {@link OtpClient#verify(OtpVerifyRequest)} (SPEC §X.3).
 *
 * <p>{@code subjectRef} + {@code purpose} name the entity to match against;
 * {@code presented} is the value typed by the end-user (or the delivery agent,
 * for delivery-confirmation flows).
 *
 * <p>Dual-mode bearer: provide EITHER {@code userBearer} OR {@code userId} (see
 * {@link OtpIssueRequest}). {@code onBehalfOfIp} is optional (BFF mode only).
 */
public record OtpVerifyRequest(String subjectRef, String purpose, String presented,
                               String userId, String userBearer, String onBehalfOfIp) {

    /** Legacy mode: use the user's own access JWT as the bearer. */
    public static OtpVerifyRequest withBearer(String subjectRef, String purpose, String presented, String userBearer) {
        return new OtpVerifyRequest(subjectRef, purpose, presented, null, userBearer, null);
    }

    /** BFF mode: act on behalf of {@code userId} via the platform token. */
    public static OtpVerifyRequest forUser(String subjectRef, String purpose, String presented, String userId) {
        return new OtpVerifyRequest(subjectRef, purpose, presented, userId, null, null);
    }
}
