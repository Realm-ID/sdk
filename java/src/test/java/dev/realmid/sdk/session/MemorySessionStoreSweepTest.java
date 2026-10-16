package dev.realmid.sdk.session;

import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** go 0.64.2: the in-memory store sweeps expired locks and outcomes instead of leaking them. */
class MemorySessionStoreSweepTest {

    private static final class MutableClock extends Clock {
        volatile Instant now = Instant.parse("2026-01-01T00:00:00Z");
        public java.time.ZoneId getZone() { return ZoneOffset.UTC; }
        public Clock withZone(java.time.ZoneId z) { return this; }
        public Instant instant() { return now; }
    }

    @Test
    void expiredLocksAndOutcomesAreSweptByLaterWritesWithoutBeingReadAgain() {
        MutableClock c = new MutableClock();
        MemorySessionStore s = new MemorySessionStore(c);
        for (int i = 0; i < 50; i++) {
            s.acquireRefreshLock("l" + i, Duration.ofSeconds(15));
            s.putRefreshResult("o" + i, new byte[]{1}, Duration.ofSeconds(5));
        }
        assertEquals(100, s.retainedLocksAndResults());
        c.now = c.now.plusSeconds(60);
        // none of the old keys is ever read or re-acquired; a fresh write sweeps them
        s.acquireRefreshLock("fresh", Duration.ofSeconds(15));
        s.putRefreshResult("fresh", new byte[]{1}, Duration.ofSeconds(5));
        assertEquals(2, s.retainedLocksAndResults());
    }
}
