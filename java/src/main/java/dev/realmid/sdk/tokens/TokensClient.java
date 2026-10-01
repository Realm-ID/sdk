package dev.realmid.sdk.tokens;

import dev.realmid.sdk.Logging;
import dev.realmid.sdk.session.MemorySessionStore;
import dev.realmid.sdk.session.OrgSessionModes;
import dev.realmid.sdk.session.SessionKeys;
import dev.realmid.sdk.session.SessionState;
import dev.realmid.sdk.session.SessionStateStore;

import java.lang.System.Logger;
import java.lang.System.Logger.Level;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import java.util.function.Function;

/**
 * Session revocation / supersession cache (SPEC §6.7, rewritten for v0.63.0).
 *
 * <p>A partner app verifies access tokens locally and learns neither of
 * RealmID's server-side session ends, so the SDK keeps partner-side state about
 * SESSIONS and refuses an access token on two grounds: <b>revoked</b> (this app
 * logged the session out) and <b>superseded</b> (the session refreshed at
 * {@code T} and the token's {@code iat < T}). Both produce the same
 * {@link TokenRevokedException}.
 *
 * <p>Everything lives in the one {@link SessionStateStore} the realm was built
 * with, keyed by the session key ({@code sid}, else {@code jti}; §6.7.1). Every
 * entry lives until {@code now + 24h} (the issuer's access-TTL ceiling),
 * extended and never shortened by a later write. Store read errors FAIL OPEN; a
 * write error is logged and never changes the response.
 */
public final class TokensClient {

    /** H, SPEC §6.7.2: no access token outlives {@code now + 24h}, whatever the realm TTL is or was. */
    static final Duration H = Duration.ofHours(24);

    private final SessionStateStore store;
    private final Clock clock;
    private final Logger logger;
    private final Function<String, String> modeOf;

    /** Single-replica convenience: concurrent mode, no logging. */
    public TokensClient(SessionStateStore store, Clock clock) {
        this(store, clock, null, null);
    }

    /**
     * @param store  REQUIRED, shared with the realm's middleware
     * @param modeOf resolves the org-session mode ({@code "concurrent"} /
     *               {@code "exclusive"}) for a token's {@code iss}; null means
     *               always {@code concurrent}. {@link OrgSessionModes#mode} is the
     *               production implementation.
     */
    public TokensClient(SessionStateStore store, Clock clock, Logger logger, Function<String, String> modeOf) {
        if (store == null) throw new IllegalArgumentException("realmid: TokensClient requires a SessionStateStore");
        this.store = store;
        this.clock = clock == null ? Clock.systemUTC() : clock;
        this.logger = logger == null ? Logging.NOOP : logger;
        this.modeOf = modeOf;
    }

    private Instant now() { return Instant.now(clock); }

    /**
     * Records the token's SESSION revoked until {@code now + 24h}. No-op without
     * a session key. Peeks, never verifies: it is the partner's own call on a
     * token the partner already holds. Revokes the session, not one token.
     */
    public void markRevoked(String accessToken) {
        SessionKeys.Peek p = SessionKeys.peek(accessToken);
        if (p == null) return;
        revokeSession(p.sessionKey());
    }

    /** Records the named session revoked until {@code now + 24h}; no-op on an empty key. */
    public void revokeSession(String sessionKey) {
        if (sessionKey == null || sessionKey.isEmpty()) return;
        try {
            store.revokeSession(SessionKeys.revokedKey(sessionKey), now().plus(H));
        } catch (RuntimeException e) {
            warn("revokeSession", e);
        }
    }

    /**
     * Raises the session mark AND the membership mark ({@code sessionKey} +
     * {@code sub}) to the token's {@code iat}, every time, whatever the mode.
     * Call it only for a refresh that ROTATED the refresh token. No-op without a
     * key, {@code sub} or {@code iat}.
     */
    public void recordRefresh(String newAccessToken) {
        SessionKeys.Peek p = SessionKeys.peek(newAccessToken);
        if (p == null || p.sessionKey() == null || p.sub() == null || p.iat() <= 0) return;
        Instant nb = Instant.ofEpochSecond(p.iat());
        Instant until = now().plus(H);
        for (String key : new String[]{
                SessionKeys.sessionMarkKey(p.sessionKey()),
                SessionKeys.membershipMarkKey(p.sessionKey(), p.sub())}) {
            try {
                store.raiseNotBefore(key, nb, until);
            } catch (RuntimeException e) {
                warn("recordRefresh", e);
            }
        }
    }

    /**
     * True iff the token's session is recorded revoked, or the not-before mark
     * the realm's mode selects is live and the token's {@code iat} is below it
     * (strictly; a token with no numeric {@code iat} against a live mark is
     * refused). Store errors fail open.
     */
    public boolean isRevoked(String accessToken) {
        SessionKeys.Peek p = SessionKeys.peek(accessToken);
        if (p == null || p.sessionKey() == null) return false;
        List<String> keys = new ArrayList<>(3);
        keys.add(SessionKeys.revokedKey(p.sessionKey()));
        keys.add(SessionKeys.sessionMarkKey(p.sessionKey()));
        if (p.sub() != null) keys.add(SessionKeys.membershipMarkKey(p.sessionKey(), p.sub()));
        List<SessionState> st;
        try {
            st = store.sessionStates(keys);
        } catch (RuntimeException e) {
            warn("isRevoked", e); // fail OPEN, as the issuer's own bearer check does
            return false;
        }
        if (st.size() != keys.size()) return false;
        if (st.get(0).revoked()) return true;
        SessionState session = st.get(1);
        SessionState member = st.size() > 2 ? st.get(2) : SessionState.NONE;
        if (session.notBefore() == null && member.notBefore() == null) return false; // no mark: no mode fetch
        boolean exclusive = OrgSessionModes.EXCLUSIVE.equals(modeOf == null ? null : modeOf.apply(p.iss()));
        Instant nb = (exclusive ? session : member).notBefore();
        if (nb == null) return false;
        return p.iat() <= 0 || p.iat() < nb.getEpochSecond();
    }

    /** Per-request gate: throws {@link TokenRevokedException} when {@link #isRevoked}. */
    public void gateRequest(String accessToken) {
        if (isRevoked(accessToken)) {
            throw new TokenRevokedException();
        }
    }

    /**
     * Wraps a logout function so the access token's session is marked revoked on
     * <b>either success or failure</b> (the key is peeked BEFORE the call).
     */
    public <REQ> WrappedLogout<REQ> revokeOnLogout(Consumer<REQ> logoutFn) {
        return (accessToken, req) -> {
            SessionKeys.Peek p = SessionKeys.peek(accessToken);
            try {
                logoutFn.accept(req);
            } finally {
                if (p != null) revokeSession(p.sessionKey());
            }
        };
    }

    /**
     * Drops the session's revoked entry, session mark and EVERY membership mark.
     * Null/empty clears everything the in-memory store holds; on a shared store
     * it is a no-op that logs a warning (the SDK never issues a keyspace-wide
     * delete).
     */
    public void evict(String sessionKey) {
        if (sessionKey == null || sessionKey.isEmpty()) {
            if (store instanceof MemorySessionStore m) {
                m.clear();
            } else if (logger.isLoggable(Level.WARNING)) {
                logger.log(Level.WARNING,
                        "realmid: tokens.evict(\"\") ignored on a shared session store; evict a session key instead");
            }
            return;
        }
        try {
            store.evict(SessionKeys.revokedKey(sessionKey));
            store.evict(SessionKeys.sessionMarkKey(sessionKey));
        } catch (RuntimeException e) {
            warn("evict", e);
        }
    }

    private void warn(String op, RuntimeException e) {
        if (logger.isLoggable(Level.WARNING)) {
            logger.log(Level.WARNING, "realmid: session store {0} failed: {1}", op, e.getMessage());
        }
    }

    /** Functional shape returned by {@link #revokeOnLogout(Consumer)}. */
    @FunctionalInterface
    public interface WrappedLogout<REQ> {
        void invoke(String accessToken, REQ req);
    }
}
