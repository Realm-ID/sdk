package dev.realmid.sdk.tokens;

import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;

import java.util.Map;

/**
 * Thrown by {@link TokensClient#gateRequest(String)} when the access
 * token's {@code jti} is in the per-process revoked cache. Subclasses
 * {@link RealmException} with code {@link ErrorCode#UNAUTHORIZED} and
 * {@code details.revoked = true} so callers can branch precisely
 * without growing the global error taxonomy.
 */
public final class TokenRevokedException extends RealmException {

    public TokenRevokedException() {
        this("access token revoked");
    }

    public TokenRevokedException(String message) {
        super(ErrorCode.UNAUTHORIZED, message, 0, Map.of("revoked", Boolean.TRUE));
    }
}
