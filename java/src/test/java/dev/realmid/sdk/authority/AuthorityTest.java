package dev.realmid.sdk.authority;

import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ADR-107, the Java half.
 *
 * <p>Java is the language where this cache had no predecessor: the ADR-041
 * partner-pluggable jti denylist that go and ts carry was never implemented
 * here, so {@code AuthorityCache} is the first pluggable cache on the Java
 * verifier at all. That makes D2's "widening breaks Java silently" argument
 * vacuous here — and the interface is still separate, because the ARGUMENT
 * being vacuous in one language does not make one cache the right shape for two
 * different keys and two different lifetimes.
 */
class AuthorityTest {

    private static final Instant NOW = Instant.parse("2026-04-01T00:00:00Z");
    private static final Clock FIXED = Clock.fixed(NOW, ZoneOffset.UTC);

    /* -------------------------------------------------- the cache */

    @Test
    void storesATimestampNotAFlag() {
        MemAuthorityCache c = new MemAuthorityCache(FIXED);
        assertNull(c.staleSince("sub-1"));

        Instant nb = NOW.minusSeconds(30);
        c.markStale("sub-1", nb, NOW.plusSeconds(900));
        // D3: a boolean could not self-heal — it would reject the REFRESHED
        // token too, locking the user out for the entry's whole TTL and turning
        // a routine demotion into an outage.
        assertEquals(nb, c.staleSince("sub-1"));
    }

    @Test
    void noEntryIsNullNeverEpoch() {
        MemAuthorityCache c = new MemAuthorityCache(FIXED);
        // Returning Instant.EPOCH here would read as "stale since 1970" — every
        // token rejected, forever — and it is a real instant, so nothing about
        // it looks wrong at the call site.
        assertNull(c.staleSince("never-marked"));
    }

    @Test
    void entryEvictsAfterItsTtl() {
        MemAuthorityCache c = new MemAuthorityCache(Clock.fixed(NOW.plusSeconds(960), ZoneOffset.UTC));
        c.markStale("sub-1", NOW, NOW.plusSeconds(900));
        assertNull(c.staleSince("sub-1"));
        assertEquals(0, c.size());
    }

    @Test
    void keyIsPerMembership() {
        MemAuthorityCache c = new MemAuthorityCache(FIXED);
        c.markStale("sub-org-a", NOW, NOW.plusSeconds(900));
        // Demoting someone in org A must leave their org B token untouched.
        // That blast radius is the whole reason `sub` was chosen over an
        // identity id (D4).
        assertNull(c.staleSince("sub-org-b"));
    }

    @Test
    void aLaterMarkerWinsAndAnEarlierOneIsDropped() {
        MemAuthorityCache c = new MemAuthorityCache(FIXED);
        c.markStale("sub-1", NOW, NOW.plusSeconds(900));
        c.markStale("sub-1", NOW.minusSeconds(300), NOW.plusSeconds(900));
        // Moving the marker backwards would un-stale tokens a previous change
        // had already invalidated.
        assertEquals(NOW, c.staleSince("sub-1"));
    }

    /* -------------------------------------------------- the notify method */

    private static Realm.Builder realm() {
        return Realm.builder()
                .realmId("01HXYZREALM")
                .apiKey("rk_live_test")
                .baseUrl("https://auth.test.example")
                .audience("example.com")
                .clock(FIXED);
    }

    @Test
    void notifyStampsTheMarkerEarly() {
        MemAuthorityCache cache = new MemAuthorityCache(FIXED);
        Realm r = realm().authority(cache).build();

        r.notifyAuthorityChanged(new AuthorityChange("sub-1", AuthorityChange.Intent.DEMOTED));

        Instant nb = cache.staleSince("sub-1");
        assertNotNull(nb);
        // D8: stamped as now − skewAllowance, NEVER as bare now. Erring EARLY
        // costs one harmless extra refresh; erring LATE places the marker in the
        // ISSUER's future, which is the only way the C5 loop starts.
        assertTrue(nb.isBefore(NOW), "marker is not before local now — D8's skew allowance is missing");
        assertEquals(NOW.minus(AuthorityChange.SKEW_ALLOWANCE), nb);
    }

    @Test
    void notifyRequiresAnIntentAndASubject() {
        Realm r = realm().authority(new MemAuthorityCache(FIXED)).build();

        // D11: demotion does NOT evict the session, so the method must not be
        // allowed to GUESS what the partner meant. One that inferred intent
        // would eventually infer "log them out" on a routine role edit.
        assertThrows(RealmException.class,
                () -> r.notifyAuthorityChanged(new AuthorityChange("sub-1", null)));
        assertThrows(RealmException.class,
                () -> r.notifyAuthorityChanged(new AuthorityChange("", AuthorityChange.Intent.PROMOTED)));
        assertThrows(RealmException.class, () -> r.notifyAuthorityChanged(null));
    }

    @Test
    void notifyWithNoCacheIsAnError() {
        Realm r = realm().build();
        RealmException ex = assertThrows(RealmException.class,
                () -> r.notifyAuthorityChanged(new AuthorityChange("sub-1", AuthorityChange.Intent.DEMOTED)));
        // D15: silence here means a partner believes demotion is propagating
        // while nothing is stored.
        assertEquals(ErrorCode.BAD_REQUEST, ex.getCode());
        assertTrue(ex.getMessage().toLowerCase().contains("authority"),
                "the error does not name the missing cache: " + ex.getMessage());
    }

    @Test
    void notifySizesTheEntryToOutliveTheAccessToken() {
        MemAuthorityCache cache = new MemAuthorityCache(FIXED);
        Realm r = realm().authority(cache).build();

        r.notifyAuthorityChanged(new AuthorityChange(
                "sub-1", AuthorityChange.Intent.DEMOTED, Duration.ofSeconds(60)));
        assertNotNull(cache.staleSince("sub-1"));

        // D6: past the access-token lifetime + leeway, no token minted before
        // the change can still verify, so the entry is dead weight.
        MemAuthorityCache later = new MemAuthorityCache(
                Clock.fixed(NOW.plusSeconds(60 + 31), ZoneOffset.UTC));
        later.markStale("sub-1",
                NOW.minus(AuthorityChange.SKEW_ALLOWANCE),
                NOW.plusSeconds(60).plus(AuthorityChange.SKEW_ALLOWANCE));
        assertNull(later.staleSince("sub-1"));
    }

    @Test
    void theConfiguredCacheIsReachable() {
        MemAuthorityCache cache = new MemAuthorityCache(FIXED);
        assertSame(cache, realm().authority(cache).build().authority());
        assertNull(realm().build().authority());
    }
}
