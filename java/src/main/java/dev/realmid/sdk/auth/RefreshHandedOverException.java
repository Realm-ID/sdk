package dev.realmid.sdk.auth;

import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;

/**
 * An error {@link AuthClient#token(TokenRequest)} threw AFTER following a hand-over (SPEC §4.2,
 * "An error after a hand-over carries the newest token"): the refresh token it held when the
 * error happened differs from the one the caller sent, so the caller's own copy is spent and
 * this carries the newest one.
 *
 * <p>It wraps the original failure as {@link #getCause()} and copies its code, message, status,
 * details and retry-after. A token-level failure ({@code refresh_invalid}, any 401) is never
 * wrapped: it carries nothing. The 3-hop give-up stays {@link RefreshSupersededException}.
 *
 * <p>The token is a credential: a {@code transient} field behind {@link #refreshToken()},
 * absent from the message, details, {@code toString()} and serialization.
 */
public final class RefreshHandedOverException extends RealmException {

    private static final long serialVersionUID = 1L;

    private final transient String refreshToken;

    /** The access token the first mint returned (SPEC4_2_rotate_handover rule 2); null when none. */
    private final transient String accessToken;

    public RefreshHandedOverException(Throwable original, String refreshToken) {
        this(original, refreshToken, null);
    }

    /**
     * @param accessToken the first mint's access token, valid but lacking the handler's claims; it
     *                    MUST NOT be cached or treated as the fully claimed session (rule 4)
     */
    public RefreshHandedOverException(Throwable original, String refreshToken, String accessToken) {
        super(codeOf(original), original.getMessage(), statusOf(original), detailsOf(original),
                original, retryAfterOf(original));
        this.refreshToken = refreshToken;
        this.accessToken = accessToken;
    }

    /** The access token the first mint returned, or null where a hand-over hop never had one. */
    public String accessToken() { return accessToken; }

    private static ErrorCode codeOf(Throwable t) {
        return t instanceof RealmException r ? r.getCode() : ErrorCode.SERVER_ERROR;
    }

    private static int statusOf(Throwable t) {
        return t instanceof RealmException r ? r.getHttpStatus() : 0;
    }

    private static java.util.Map<String, Object> detailsOf(Throwable t) {
        return t instanceof RealmException r ? r.getDetails() : null;
    }

    private static java.time.Duration retryAfterOf(Throwable t) {
        return t instanceof RealmException r ? r.getRetryAfter().orElse(null) : null;
    }

    /** The newest refresh token the call held; present it on the next attempt. */
    public String refreshToken() { return refreshToken; }
}
