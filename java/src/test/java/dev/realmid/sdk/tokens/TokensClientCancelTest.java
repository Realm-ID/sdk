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
class TokensClientCancelTest {

    /** Throws when the CALLING thread is interrupted, as a request-scoped store (JDBC, Jedis) does. */
    static final class InterruptSensitive implements SessionStateStore {
        final MemorySessionStore inner = new MemorySessionStore();
        volatile long readDelayMs;
        final AtomicBoolean sawInterrupt = new AtomicBoolean();
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
        public RefreshLock acquireRefreshLock(String k, Duration t) { return inner.acquireRefreshLock(k, t); }
        public void putRefreshResult(String k, byte[] r, Duration t) { inner.putRefreshResult(k, r, t); }
        public Optional<byte[]> getRefreshResult(String k) { return inner.getRefreshResult(k); }
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
