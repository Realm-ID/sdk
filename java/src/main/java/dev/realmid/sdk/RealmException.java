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
}
