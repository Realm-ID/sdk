package dev.realmid.sdk.tokens;

import dev.realmid.sdk.session.MemorySessionStore;
import dev.realmid.sdk.session.SessionKeys;
import dev.realmid.sdk.session.SessionState;
import dev.realmid.sdk.session.SessionStateStore;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.*;

/** SPEC 6.7.2 / go 0.63.1: a client hang-up is not a store error; store calls are detached and bounded at 2 s. */
public class TokensClientCancelTest {

    /** Throws when the CALLING thread is interrupted, as a request-scoped store (JDBC, Jedis) does. */
    public static final class InterruptSensitive implements SessionStateStore {
        public final MemorySessionStore inner = new MemorySessionStore();
        public volatile long readDelayMs;
        public final AtomicBoolean sawInterrupt = new AtomicBoolean();
        public void revokeSession(String k, Instant u) { check(); inner.revokeSession(k, u); }
        public void raiseNotBefore(String k, Instant nb, Instant u) { check(); inner.raiseNotBefore(k, nb, u); }
        public List<SessionState> sessionStates(List<String> k) {
            check();
            if (readDelayMs > 0) {
                try { Thread.sleep(readDelayMs); } catch (InterruptedException e) { throw new IllegalStateException(e); }
            }
            return inner.sessionStates(k);
        }
        public void evict(String p) { check(); inner.evict(p); }
        public RefreshLock acquireRefreshLock(String k, Duration t) {
            check();
            RefreshLock l = inner.acquireRefreshLock(k, t);
            return new RefreshLock(l.acquired(), () -> { check(); l.release().run(); });
        }
        public void putRefreshResult(String k, byte[] r, Duration t) { check(); inner.putRefreshResult(k, r, t); }
        public Optional<byte[]> getRefreshResult(String k) { check(); return inner.getRefreshResult(k); }
        private void check() {
            if (Thread.currentThread().isInterrupted()) {
                sawInterrupt.set(true);
                throw new IllegalStateException("request cancelled");
            }
        }
    }

    private static String jwt(String sid) {
        Base64.Encoder e = Base64.getUrlEncoder().withoutPadding();
        String h = e.encodeToString("{\"alg\":\"RS256\"}".getBytes());
        String p = e.encodeToString(("{\"sid\":\"" + sid + "\",\"sub\":\"u1\",\"iat\":100}").getBytes());
        return h + "." + p + ".sig";
    }

    @Test
    void SPEC6_7_2_anInterruptedRequestThreadDoesNotMakeTheRevocationReadFailOpen() {
        InterruptSensitive store = new InterruptSensitive();
        TokensClient t = new TokensClient(store, null);
        t.revokeSession("S1");
        Thread.currentThread().interrupt();
        try {
            assertTrue(t.isRevoked(jwt("S1")), "a hang-up is not a store error");
            assertTrue(Thread.currentThread().isInterrupted(), "interrupt status is preserved for the caller");
        } finally {
            Thread.interrupted();
        }
        assertFalse(store.sawInterrupt.get(), "the store call ran detached from the request thread");
    }

    @Test
    void SPEC6_7_2_anInterruptedRequestStillRecordsRevokeAndRefreshAndEvict() {
        InterruptSensitive store = new InterruptSensitive();
        TokensClient t = new TokensClient(store, null);
        Thread.currentThread().interrupt();
        try {
            t.revokeSession("S2");
            t.recordRefresh(jwt("S2"));
            t.evict("S3");
        } finally {
            Thread.interrupted();
        }
        assertTrue(t.isRevoked(jwt("S2")));
        assertNotNull(store.inner.sessionStates(List.of(SessionKeys.sessionMarkKey("S2"))).get(0).notBefore());
    }

    @Test
    void SPEC6_7_2_oneBearerCheckSharesOneTwoSecondBudgetAcrossTheStoreReadAndTheModeFetch() {
        InterruptSensitive store = new InterruptSensitive();
        store.inner.raiseNotBefore(SessionKeys.sessionMarkKey("S1"), Instant.ofEpochSecond(200),
                Instant.now().plusSeconds(3600));
        TokensClient t = new TokensClient(store, java.time.Clock.systemUTC(), null, iss -> {
            try { Thread.sleep(10_000); } catch (InterruptedException e) { throw new IllegalStateException(e); }
            return "exclusive";
        });
        store.readDelayMs = 1_200;
        long t0 = System.nanoTime();
        assertFalse(t.isRevoked(jwt("S1")), "unreadable mode means concurrent: this token's membership has no mark");
        long ms = (System.nanoTime() - t0) / 1_000_000;
        assertTrue(ms < 2_600, "one shared 2 s budget, took " + ms + " ms");
    }

    @Test
    void SPEC6_7_2_aHungStoreIsBoundedAtTheStoreTimeoutAndStillFailsOpen() {
        InterruptSensitive store = new InterruptSensitive();
        TokensClient t = new TokensClient(store, null);
        t.revokeSession("S1");
        store.readDelayMs = 30_000;
        long t0 = System.nanoTime();
        assertFalse(t.isRevoked(jwt("S1")));
        long ms = (System.nanoTime() - t0) / 1_000_000;
        assertTrue(ms < 4_000, "bounded by the 2 s store timeout, took " + ms + " ms");
    }
}
