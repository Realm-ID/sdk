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
}
