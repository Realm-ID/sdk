package dev.realmid.sdk.revocation;

import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ADR-041's jti denylist, which Java did not have until 2026-09-04.
 *
 * <p>go and ts shipped it with ADR-041. Java's absence was invisible: nothing
 * failed, no interface was missing from a place anyone looked, and
 * {@code TokensClient.isRevoked} sits next door doing a different job, which is
 * why the gap read as filled at a glance. It was found only because ADR-107's
 * own rationale assumed this existed here.
 */
class MemRevocationCacheTest {

    private static final Instant NOW = Instant.parse("2026-04-01T00:00:00Z");
    private static final Clock FIXED = Clock.fixed(NOW, ZoneOffset.UTC);

    @Test
    void emptyCacheReportsNotRevoked() {
        assertFalse(new MemRevocationCache(FIXED).isRevoked("any"));
    }

    @Test
    void revokedJtiReportsTrueWithinTtl() {
        MemRevocationCache c = new MemRevocationCache(FIXED);
        c.revoke("jti-1", NOW.plusSeconds(900));
        assertTrue(c.isRevoked("jti-1"));
    }

    @Test
    void expiredEntryEvictsLazily() {
        MemRevocationCache c = new MemRevocationCache(Clock.fixed(NOW.plusSeconds(960), ZoneOffset.UTC));
        c.revoke("jti-1", NOW.plusSeconds(900));
        // Past its own exp the token cannot verify anyway, so the entry is dead
        // weight — this is what bounds the cache, not a sweeper.
        assertFalse(c.isRevoked("jti-1"));
        assertEquals(0, c.size());
    }

    @Test
    void anUnreadableExpiryKeepsTheEntryRatherThanDroppingIt() {
        MemRevocationCache c = new MemRevocationCache(Clock.fixed(NOW.plusSeconds(999_999), ZoneOffset.UTC));
        c.revoke("jti-1", null);
        // Dropping it would UN-REVOKE the token, which is the one outcome a
        // denylist must never produce. Erring the other way merely leaks one
        // map entry.
        assertTrue(c.isRevoked("jti-1"));
    }

    @Test
    void emptyJtiIsANoOp() {
        MemRevocationCache c = new MemRevocationCache(FIXED);
        c.revoke("", NOW.plusSeconds(900));
        c.revoke(null, NOW.plusSeconds(900));
        assertFalse(c.isRevoked(""));
        assertFalse(c.isRevoked(null));
        assertEquals(0, c.size());
    }
}
