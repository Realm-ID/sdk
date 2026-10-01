package dev.realmid.sdk.session;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * In-memory {@link SessionStateStore} (SPEC §6.7.5). Zero dependencies.
 *
 * <p><b>Passing this IS the partner's statement that they run ONE replica.</b>
 * A revocation, a not-before mark or a refresh lock written on replica A is
 * invisible to replica B; a multi-replica deployment supplies a shared store.
 * Two {@code Realm}s given two instances share nothing.
 */
public final class MemorySessionStore implements SessionStateStore {

    private static final class Entry {
        boolean revoked;
        Instant notBefore; // null = none
        Instant until;
    }

    private record Held(String token, Instant until) {}
    private record Result(byte[] bytes, Instant until) {}

    private final Clock clock;
    private final Map<String, Entry> entries = new HashMap<>();
    private final Map<String, Held> locks = new HashMap<>();
    private final Map<String, Result> results = new HashMap<>();
    private long tokenSeq;

    public MemorySessionStore() { this(Clock.systemUTC()); }

    public MemorySessionStore(Clock clock) { this.clock = clock == null ? Clock.systemUTC() : clock; }

    private Instant now() { return Instant.now(clock); }

    @Override
    public synchronized void revokeSession(String key, Instant until) {
        Entry e = entries.computeIfAbsent(key, k -> new Entry());
        e.revoked = true;
        e.until = later(e.until, until);
    }

    @Override
    public synchronized void raiseNotBefore(String key, Instant nb, Instant until) {
        Entry e = entries.computeIfAbsent(key, k -> new Entry());
        e.notBefore = later(e.notBefore, nb);
        e.until = later(e.until, until);
    }

    private static Instant later(Instant a, Instant b) {
        if (a == null) return b;
        if (b == null) return a;
        return a.isAfter(b) ? a : b;
    }

    @Override
    public synchronized List<SessionState> sessionStates(List<String> keys) {
        Instant now = now();
        List<SessionState> out = new ArrayList<>(keys.size());
        for (String k : keys) {
            Entry e = entries.get(k);
            if (e == null) { out.add(SessionState.NONE); continue; }
            if (e.until == null || !e.until.isAfter(now)) {
                entries.remove(k); // lazy GC
                out.add(SessionState.NONE);
                continue;
            }
            out.add(new SessionState(e.revoked, e.notBefore));
        }
        return out;
    }

    @Override
    public synchronized void evict(String prefix) {
        String sub = prefix + "|";
        entries.keySet().removeIf(k -> k.equals(prefix) || k.startsWith(sub));
    }

    /** Drops everything the store holds ({@code TokensClient#evict("")}). */
    public synchronized void clear() {
        entries.clear();
    }

    /** Live entry count (tests / instrumentation). */
    public synchronized int size() {
        Instant now = now();
        entries.values().removeIf(e -> e.until == null || !e.until.isAfter(now));
        return entries.size();
    }

    @Override
    public synchronized RefreshLock acquireRefreshLock(String key, Duration ttl) {
        Instant now = now();
        Held h = locks.get(key);
        if (h != null && h.until().isAfter(now)) return RefreshLock.notAcquired();
        String token = "h" + (++tokenSeq);
        locks.put(key, new Held(token, now.plus(ttl)));
        return new RefreshLock(true, () -> releaseIfOwner(key, token));
    }

    private synchronized void releaseIfOwner(String key, String token) {
        Held h = locks.get(key);
        if (h != null && h.token().equals(token)) locks.remove(key);
    }

    @Override
    public synchronized void putRefreshResult(String key, byte[] result, Duration ttl) {
        results.put(key, new Result(result.clone(), now().plus(ttl)));
    }

    @Override
    public synchronized Optional<byte[]> getRefreshResult(String key) {
        Result r = results.get(key);
        if (r == null) return Optional.empty();
        if (!r.until().isAfter(now())) {
            results.remove(key);
            return Optional.empty();
        }
        return Optional.of(r.bytes().clone());
    }
}
