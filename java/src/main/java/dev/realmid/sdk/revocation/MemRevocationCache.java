package dev.realmid.sdk.revocation;

import java.time.Clock;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Single-process {@link RevocationCache}, lazily evicting on read.
 *
 * <p><b>⚠️ Correct for ONE replica and for tests, and silently wrong for
 * more.</b> A jti revoked on replica A is unknown to replica B, so a logout
 * stops the bleed only on whichever replica happens to serve the next request.
 * Multi-replica deployments implement {@link RevocationCache} over Redis or
 * equivalent. The SDK cannot detect the second replica, so it cannot warn.
 */
public final class MemRevocationCache implements RevocationCache {

    private final Map<String, Instant> entries = new ConcurrentHashMap<>();
    private final Clock clock;

    /** Uses the system clock. */
    public MemRevocationCache() {
        this(Clock.systemUTC());
    }

    /** @param clock the clock; {@code null} means {@link Clock#systemUTC()}. */
    public MemRevocationCache(Clock clock) {
        this.clock = clock == null ? Clock.systemUTC() : clock;
    }

    @Override
    public void revoke(String jti, Instant expiresAt) {
        if (jti == null || jti.isEmpty()) return;
        // Instant.MAX stands in for "no known expiry" so the map stays
        // null-free: ConcurrentHashMap rejects null values, and a token with no
        // readable exp must stay revoked rather than silently un-revoke.
        entries.put(jti, expiresAt == null ? Instant.MAX : expiresAt);
    }

    @Override
    public boolean isRevoked(String jti) {
        if (jti == null || jti.isEmpty()) return false;
        Instant exp = entries.get(jti);
        if (exp == null) return false;
        if (exp != Instant.MAX && Instant.now(clock).isAfter(exp)) {
            entries.remove(jti, exp);
            return false;
        }
        return true;
    }

    /** Current entry count. Useful for tests + instrumentation. */
    public int size() {
        return entries.size();
    }
}
