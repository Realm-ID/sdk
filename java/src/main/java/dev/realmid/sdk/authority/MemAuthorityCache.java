package dev.realmid.sdk.authority;

import java.time.Clock;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Single-process {@link AuthorityCache}, lazily evicting on read.
 *
 * <p><b>⚠️ Correct for ONE replica and for tests, and silently wrong for
 * more.</b> A marker written on replica A is invisible to replica B, so a
 * demotion reaches only whichever replica happens to serve the next request. A
 * multi-replica partner supplies Redis or equivalent — under ADR-107 D1 that is
 * a DEPLOYMENT REQUIREMENT, not a tuning choice, and the SDK cannot detect the
 * second replica to warn about it.
 */
public final class MemAuthorityCache implements AuthorityCache {

    private record Entry(Instant notBefore, Instant expiresAt) {}

    private final Map<String, Entry> entries = new ConcurrentHashMap<>();
    private final Clock clock;

    /** Uses the system clock. */
    public MemAuthorityCache() {
        this(Clock.systemUTC());
    }

    /** @param clock the clock; {@code null} means {@link Clock#systemUTC()}. */
    public MemAuthorityCache(Clock clock) {
        this.clock = clock == null ? Clock.systemUTC() : clock;
    }

    @Override
    public void markStale(String sub, Instant notBefore, Instant expiresAt) {
        if (sub == null || sub.isEmpty() || notBefore == null) return;
        // A later marker always wins; an EARLIER one is dropped rather than
        // stored, since moving the marker backwards would un-stale tokens a
        // previous change had already invalidated.
        entries.merge(sub, new Entry(notBefore, expiresAt), (prev, next) ->
                prev.notBefore().isAfter(next.notBefore())
                        ? new Entry(prev.notBefore(), next.expiresAt())
                        : next);
    }

    @Override
    public Instant staleSince(String sub) {
        if (sub == null || sub.isEmpty()) return null;
        Entry e = entries.get(sub);
        if (e == null) return null;
        if (e.expiresAt() != null && Instant.now(clock).isAfter(e.expiresAt())) {
            entries.remove(sub, e);
            return null;
        }
        return e.notBefore();
    }

    /** Current entry count. Useful for tests + instrumentation. */
    public int size() {
        return entries.size();
    }
}
