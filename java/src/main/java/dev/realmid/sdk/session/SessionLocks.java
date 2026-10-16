package dev.realmid.sdk.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;

import java.time.Duration;

/**
 * The per-session refresh lock (SPEC §10.1 step 4a) as one wait-and-acquire
 * loop, shared by the middleware's MFA routes and by a direct
 * {@code AuthClient} call given a {@code refreshToken} (SPEC §4.3, go 0.64.2).
 * It fails CLOSED: the issuer is never called without the lock.
 *
 * <p>Internal to the SDK.
 */
public final class SessionLocks {

    /** Mint bound (10 s) + 5 s: the bound starts after the acquire and a reload read. */
    public static final Duration LOCK_TTL = Duration.ofSeconds(15);
    public static final Duration OUTCOME_TTL = Duration.ofSeconds(5);
    /** The work done under the lock is bounded here, below {@link #LOCK_TTL}. */
    public static final Duration WORK_BOUND = Duration.ofSeconds(10);
    public static final long POLL_MILLIS = 50;
    public static final int POLL_TRIES = 60;

    private SessionLocks() {}

    /**
     * Takes the lock keyed on {@code refreshToken}, WAITING for it when held.
     *
     * @return the release; call it in a {@code finally}. It swallows a store
     *         failure (the TTL frees the lock).
     * @throws RealmException {@code server_error} 503 "session store unavailable" when the store
     *         errored, 503 "refresh in progress" when the lock was never acquired, and 503
     *         "cancelled" when the calling thread was interrupted while waiting (its interrupt
     *         status is restored)
     */
    public static Runnable acquire(SessionStateStore store, String refreshToken, long pollMillis, int tries) {
        String key = SessionKeys.lockKey(refreshToken);
        for (int i = 0; i < tries; i++) {
            if (Thread.currentThread().isInterrupted()) throw cancelled();
            SessionStateStore.RefreshLock l;
            try {
                l = store.acquireRefreshLock(key, LOCK_TTL);
            } catch (RuntimeException e) {
                if (Thread.currentThread().isInterrupted()) throw cancelled();
                throw new RealmException(ErrorCode.SERVER_ERROR, "session store unavailable", 503, null, e);
            }
            if (l.acquired()) {
                Runnable rel = l.release();
                return () -> {
                    try {
                        rel.run();
                    } catch (RuntimeException ignored) { /* the TTL frees it */ }
                };
            }
            try {
                Thread.sleep(pollMillis);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw cancelled();
            }
        }
        if (Thread.currentThread().isInterrupted()) throw cancelled();
        throw new RealmException(ErrorCode.SERVER_ERROR, "refresh in progress", 503, null);
    }

    private static RealmException cancelled() {
        return new RealmException(ErrorCode.SERVER_ERROR, "cancelled while waiting for the session lock", 503, null);
    }

    /**
     * Stores the {@code mfa-verify} outcome a refresh waiting on this lock adopts: the rotated
     * token, keyed on the CURRENT one. Best effort; reports whether it was stored.
     */
    public static boolean storeMfaOutcome(SessionStateStore store, ObjectMapper m, String currentRefresh, String rotated) {
        try {
            store.putRefreshResult(SessionKeys.outcomeKey(currentRefresh),
                    RefreshOutcome.mfaVerify(rotated, currentRefresh).encode(m), OUTCOME_TTL);
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }
}
