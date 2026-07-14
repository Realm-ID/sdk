package dev.realmid.sdk.otp;

/**
 * Request for {@link OtpClient#issue(OtpIssueRequest)} (SPEC §X.1).
 *
 * <p>{@code subjectRef} names the entity the OTP is bound to and
 * {@code purpose} is the partner-side tag (free string, regex
 * {@code ^[a-z][a-z0-9_]{0,63}$}) — both opaque, tenant-scoped strings.
 *
 * <p>Dual-mode bearer: provide EITHER {@code userBearer} (the user's own access
 * JWT, legacy mode) OR {@code userId} (BFF mode, the SDK sends the platform
 * token + {@code X-On-Behalf-Of-User}). {@code onBehalfOfIp} is optional and
 * only meaningful in BFF mode.
 *
 * <p>{@code deliveryMode} (ADR-071 §4) selects how the OTP reaches the
 * end-user. v1 supports {@link #DELIVERY_MODE_VIEW_BFF} only (the plaintext
 * value is returned for BFF display); null defers to the issuer default. A
 * {@code purpose="login"} OTP for a service account requires {@code view_bff}.
 */
public record OtpIssueRequest(String subjectRef, String purpose,
                              String userId, String userBearer, String onBehalfOfIp,
                              String deliveryMode) {

    /** ADR-071 §4 delivery mode: plaintext OTP returned to the BFF for display. */
    public static final String DELIVERY_MODE_VIEW_BFF = "view_bff";

    /** Back-compat 5-arg constructor (no delivery mode — issuer default). */
    public OtpIssueRequest(String subjectRef, String purpose,
                           String userId, String userBearer, String onBehalfOfIp) {
        this(subjectRef, purpose, userId, userBearer, onBehalfOfIp, null);
    }

    /** Legacy mode: use the user's own access JWT as the bearer. */
    public static OtpIssueRequest withBearer(String subjectRef, String purpose, String userBearer) {
        return new OtpIssueRequest(subjectRef, purpose, null, userBearer, null);
    }

    /** BFF mode: act on behalf of {@code userId} via the platform token. */
    public static OtpIssueRequest forUser(String subjectRef, String purpose, String userId) {
        return new OtpIssueRequest(subjectRef, purpose, userId, null, null);
    }

    /** Return a copy of this request with {@code deliveryMode} set. */
    public OtpIssueRequest withDeliveryMode(String mode) {
        return new OtpIssueRequest(subjectRef, purpose, userId, userBearer, onBehalfOfIp, mode);
    }
}
