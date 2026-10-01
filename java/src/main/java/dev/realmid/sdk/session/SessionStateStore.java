package dev.realmid.sdk.session;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * SPEC §6.7.5 — the ONE store behind every piece of cross-request session state
 * the SDK keeps: revoked sessions, the not-before marks, the §10.1 step 4a
 * refresh lock and its outcome handoff.
 *
 * <p>It is REQUIRED and passed explicitly ({@code Realm.Builder#sessionStore}),
 * even the in-memory one: a silent in-memory default let a multi-replica partner
 * believe refresh was serialized when it was not. Keys are opaque strings built
 * by the SDK ({@link SessionKeys}); every one starts with {@code realmid:v1:}.
 * Methods are synchronous and throw on failure.
 *
 * <p>Atomicity: {@link #revokeSession} and {@link #raiseNotBefore} are atomic
 * per key (Redis: one Lua script comparing and setting value and PEXPIREAT
 * together — a plain SET + EXPIRE can SHORTEN a revocation).
 * {@link #acquireRefreshLock} is set-if-absent with TTL and its release is a
 * compare-and-delete. Nothing else is required to be atomic. Run
 * {@link SessionStateStoreConformance} against a shared implementation.
 */
public interface SessionStateStore {

    /**
     * Marks {@code key} revoked. The entry lives until the LATEST {@code until}
     * ever written for {@code key}: a write never shortens it.
     */
    void revokeSession(String key, Instant until);

    /**
     * Stores {@code max(stored, nb)} (never lowers it) and extends the entry's
     * life to {@code max(stored until, until)} — both maxima in ONE atomic step.
     */
    void raiseNotBefore(String key, Instant nb, Instant until);

    /**
     * Live state of each key, in order ({@link SessionState#NONE} for an absent
     * or expired key). One round trip; NOT required to be atomic across keys.
     */
    List<SessionState> sessionStates(List<String> keys);

    /** Drops every entry whose key equals {@code prefix} or starts with {@code prefix + "|"}. */
    void evict(String prefix);

    /**
     * Refresh single-flight lock (§10.1 step 4a): SET-IF-ABSENT WITH TTL,
     * atomically. {@link RefreshLock#release()} is FENCED: it frees the lock only
     * if this holder still owns it.
     */
    RefreshLock acquireRefreshLock(String key, Duration ttl);

    /**
     * Stores an opaque SDK-encoded outcome holding live credentials: keep it
     * secret, and only for exactly {@code ttl} (never extended).
     */
    void putRefreshResult(String key, byte[] result, Duration ttl);

    Optional<byte[]> getRefreshResult(String key);

    /** Result of {@link #acquireRefreshLock}. {@code release} is never null. */
    record RefreshLock(boolean acquired, Runnable release) {
        public static RefreshLock notAcquired() { return new RefreshLock(false, () -> {}); }
    }
}
