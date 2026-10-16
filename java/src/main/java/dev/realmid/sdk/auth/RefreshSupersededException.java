package dev.realmid.sdk.auth;

import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;

/**
 * {@link AuthClient#token(TokenRequest)}'s give-up after three hand-overs
 * (SPEC §4.2, go 0.64.2): a retryable 503 {@code server_error} that carries the
 * newest LIVE refresh token for the caller's next attempt.
 *
 * <p>The token is a credential, so it lives in a {@code transient} field behind
 * {@link #refreshToken()} and appears in no message, detail map or
 * {@code toString()}, which is what a logger reaches.
 */
public final class RefreshSupersededException extends RealmException {

    private static final long serialVersionUID = 1L;

    private final transient String refreshToken;

    public RefreshSupersededException(String refreshToken) {
        super(ErrorCode.SERVER_ERROR, "refresh superseded, retry", 503, null);
        this.refreshToken = refreshToken;
    }

    /** The newest live refresh token; present it on the next call. */
    public String refreshToken() { return refreshToken; }
}
