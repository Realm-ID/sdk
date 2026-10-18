package dev.realmid.sdk;

import java.util.Collections;
import java.util.Map;

/**
 * Unified runtime exception for every SDK failure (SPEC §3).
 * Carries a stable {@link ErrorCode}, the HTTP status (when network-originated),
 * and any envelope siblings the server attached (e.g. {@code mfa_challenge_token}).
 */
public class RealmException extends RuntimeException {

    private final ErrorCode code;
    private final int httpStatus;
    private final Map<String, Object> details;

    public RealmException(ErrorCode code, String message) {
        this(code, message, 0, null, null);
    }

    public RealmException(ErrorCode code, String message, Throwable cause) {
        this(code, message, 0, null, cause);
    }

    public RealmException(ErrorCode code, String message, int httpStatus, Map<String, Object> details) {
        this(code, message, httpStatus, details, null);
    }

    public RealmException(ErrorCode code, String message, int httpStatus, Map<String, Object> details, Throwable cause) {
        super(message, cause);
        this.code = code;
        this.httpStatus = httpStatus;
        this.details = details == null ? Collections.emptyMap() : Collections.unmodifiableMap(details);
    }

    public ErrorCode getCode() { return code; }

    /** 0 if not network-originated. */
    public int getHttpStatus() { return httpStatus; }

    /** Server-supplied envelope siblings (e.g. mfa_challenge_token). Never null. */
    public Map<String, Object> getDetails() { return details; }

    /**
     * True when {@code t} is the issuer's 403 {@code tenant_disabled}: the org
     * the token is for is suspended or deactivated. Do NOT sign the user out;
     * their other orgs are unaffected.
     */
    public static boolean isTenantDisabled(Throwable t) {
        return t instanceof RealmException re && re.code == ErrorCode.TENANT_DISABLED;
    }

    /**
     * True when {@code t} is the issuer's 403 {@code user_suspended} (ADR-104
     * R-d): the subject's row in that org is suspended or deactivated. Not a
     * sign-out; the person may be active elsewhere.
     */
    public static boolean isUserSuspended(Throwable t) {
        return t instanceof RealmException re && re.code == ErrorCode.USER_SUSPENDED;
    }

    /**
     * True when {@code t} is {@code escort_suspended} (ADR-104 R-d): the BFF's
     * own escort principal is suspended. Not a sign-out.
     */
    public static boolean isEscortSuspended(Throwable t) {
        return t instanceof RealmException re && re.code == ErrorCode.ESCORT_SUSPENDED;
    }

    /** 400 {@code invalid_channel_config}: a messaging save broke a shape rule; the message names the field. */
    public static boolean isInvalidChannelConfig(Throwable t) {
        return t instanceof RealmException re && re.code == ErrorCode.INVALID_CHANNEL_CONFIG;
    }

    /** 422 {@code channel_validation_failed}: the provider refused the credentials; nothing was stored. */
    public static boolean isChannelValidationFailed(Throwable t) {
        return t instanceof RealmException re && re.code == ErrorCode.CHANNEL_VALIDATION_FAILED;
    }

    /** 404 {@code channel_not_configured}: the realm has saved nothing for that channel. */
    public static boolean isChannelNotConfigured(Throwable t) {
        return t instanceof RealmException re && re.code == ErrorCode.CHANNEL_NOT_CONFIGURED;
    }

    /**
     * 429 {@code phone_otp_rate_limited}: this number was sent the realm's limit of phone codes
     * within the window. The wait is the Retry-After header, which this SDK does not surface.
     */
    public static boolean isPhoneOtpRateLimited(Throwable t) {
        return t instanceof RealmException re && re.code == ErrorCode.PHONE_OTP_RATE_LIMITED;
    }

    /**
     * 429 {@code sign_in_ip_rate_limited}: this end user's IP (the {@code onBehalfOfIp} passed to
     * {@code sendLoginCode}) used the realm's {@code phone_otp.sign_in_per_ip_per_hour}.
     */
    public static boolean isSignInIpRateLimited(Throwable t) {
        return t instanceof RealmException re && re.code == ErrorCode.SIGN_IN_IP_RATE_LIMITED;
    }

    /**
     * 503 {@code delivery_unavailable}: the realm has no working channel for the requested
     * delivery mode ({@code details.channel} names it). The code is NOT registered, so it arrives
     * as {@code details.server_code}; this checks that place and keeps working if the code is
     * registered later.
     */
    public static boolean isDeliveryUnavailable(Throwable t) {
        return t instanceof RealmException re && "delivery_unavailable".equals(re.details.get("server_code"));
    }
}
