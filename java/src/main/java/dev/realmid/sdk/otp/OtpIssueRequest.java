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
 * <p>{@code deliveryMode} selects how the OTP reaches the end-user; null
 * defers to the issuer default ({@code view_bff}). The withholding rule is what
 * distinguishes the modes: {@code view_bff} returns the plaintext to the
 * CALLER, while {@code email} and {@code sms} have RealmID deliver it to the
 * SUBJECT and the caller receives nothing.
 *
 * <p><b>⚠️ For {@code purpose="login"} that rule decides WHO MAY BE
 * AUTHENTICATED</b> (ADR-103 D3/D4), not merely how the code travels:
 * {@code view_bff} is read by the PARTNER, so it authenticates
 * {@code kind=service} subjects only and is owner-gated; {@code sms} is read by
 * the SUBJECT, so it authenticates any kind; {@code email} is refused, because
 * a login code mailed to an address turns mailbox access into account access
 * with no second factor.
 *
 * <p>There is NO FALLBACK between the RI-delivered modes: asking for
 * {@code sms} and silently receiving mail would substitute the channel the
 * subject controls, which is the whole property.
 */
public record OtpIssueRequest(String subjectRef, String purpose,
                              String userId, String userBearer, String onBehalfOfIp,
                              String deliveryMode) {

    /** ADR-071 §4: plaintext OTP returned to the authorized caller. The default. */
    public static final String DELIVERY_MODE_VIEW_BFF = "view_bff";

    /** ADR-095 D7: RealmID emails the code to the subject. Refused for {@code purpose="login"}. */
    public static final String DELIVERY_MODE_EMAIL = "email";

    /**
     * ADR-103: RealmID texts the code to the subject's phone. Allowed for
     * {@code purpose="login"}, for a principal of ANY kind.
     */
    public static final String DELIVERY_MODE_SMS = "sms";

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
