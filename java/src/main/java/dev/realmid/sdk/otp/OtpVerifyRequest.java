package dev.realmid.sdk.otp;

/**
 * Request for {@link OtpClient#verify(OtpVerifyRequest)} (SPEC §X.3).
 *
 * <p>{@code subjectRef} + {@code purpose} name the entity to match against;
 * {@code presented} is the value typed by the end-user (or the delivery agent,
 * for delivery-confirmation flows).
 *
 * <p>Actor (R60): {@code userToken} rides in X-User-Token, or the realm carries one via {@code withUserToken}; {@code userId} is attribution only (see
 * {@link OtpIssueRequest}). {@code onBehalfOfIp} is optional (BFF mode only).
 */
public record OtpVerifyRequest(String subjectRef, String purpose, String presented,
                               String userId, String userToken, String onBehalfOfIp) {

    /** Never prints a credential. */
    @Override
    public String toString() {
        return "OtpVerifyRequest[subjectRef=" + subjectRef + ", purpose=" + purpose + ", userId=" + userId + ", onBehalfOfIp=" + onBehalfOfIp + "]";
    }


    /** Per-call actor: the user's access JWT rides in X-User-Token (never as the bearer, R60). */
    public static OtpVerifyRequest withUserToken(String subjectRef, String purpose, String presented, String userToken) {
        return new OtpVerifyRequest(subjectRef, purpose, presented, null, userToken, null);
    }

    /** BFF mode: act on behalf of {@code userId} via the platform token. */
    public static OtpVerifyRequest forUser(String subjectRef, String purpose, String presented, String userId) {
        return new OtpVerifyRequest(subjectRef, purpose, presented, userId, null, null);
    }
}
