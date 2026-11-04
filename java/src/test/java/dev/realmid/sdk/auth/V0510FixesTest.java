package dev.realmid.sdk.auth;

import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import dev.realmid.sdk.session.Detached;
import dev.realmid.sdk.session.SessionKeys;
import dev.realmid.sdk.session.SessionLocks;
import dev.realmid.sdk.tokens.TokensClientCancelTest.InterruptSensitive;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

/**
 * The 0.51.0 critic fixes: partner hooks stay on the CALLING thread, refresh-lock writes run
 * detached from an interrupted caller, the detached pool is bounded, and the token() give-up
 * is driven end to end.
 */
class V0510FixesTest {

    private static final ThreadLocal<String> REQUEST = new ThreadLocal<>();

    private FakeServer fs;
    private InterruptSensitive store;
    private final AtomicInteger tokenCalls = new AtomicInteger();
    private final AtomicInteger verifyCalls = new AtomicInteger();
    private final List<String> hookSaw = Collections.synchronizedList(new ArrayList<>());
    private volatile long verifyDelayMs;
    private volatile long tokenDelayMs;
    private volatile CountDownLatch issuerEntered = new CountDownLatch(1);

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        store = new InterruptSensitive();
        fs.onJson("POST /auth/login", (body, rec) -> FakeServer.Reply.json(200, Map.of(
                "access_token", "pt-12345", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform")));
        fs.onJson("POST /auth/mfa/verify", (body, rec) -> {
            verifyCalls.incrementAndGet();
            issuerEntered.countDown();
            sleep(verifyDelayMs);
            return FakeServer.Reply.json(200, Map.of("access_token", "at", "refresh_token", "ROTATED", "expires_in", 60,
                    "user", Map.of("id", "u1"), "tenants", List.of(Map.of("tenant_id", "t1", "role", "owner"))));
        });
        fs.onJson("POST /auth/token", (body, rec) -> {
            tokenCalls.incrementAndGet();
            issuerEntered.countDown();
            sleep(tokenDelayMs);
            return FakeServer.Reply.json(200, Map.of("access_token", "AT-" + body.get("tenant_id"),
                    "refresh_token", "R2", "expires_in", 900, "subject_type", "user",
                    "tenant_id", String.valueOf(body.get("tenant_id")), "role", "member"));
        });
    }

    @AfterEach
    void tearDown() { fs.close(); }

    private static void sleep(long ms) {
        try { if (ms > 0) Thread.sleep(ms); } catch (InterruptedException ignored) { }
    }

    private Realm realm() {
        return Realm.builder().sessionStore(store).realmId("01HREALM").apiKey("rk_live_test")
                .baseUrl(fs.baseUrl).audience("acme.test")
                .productRoles((t, u) -> { hookSaw.add("roles:" + REQUEST.get()); return List.of("dispatch"); })
                .scopes((t, u) -> { hookSaw.add("scopes:" + REQUEST.get()); return List.of("a:read"); })
                .onIdentityResolved(e -> hookSaw.add("identity:" + REQUEST.get()))
                .build();
    }

    // ---- 1. hooks run on the calling thread ----

    @Test
    void SPEC6_7_2_directMfaRunsPartnerHooksOnTheCallingThreadUnderTheLock() {
        REQUEST.set("req-1");
        try {
            realm().auth().mfaVerify(new MFAVerifyRequest("chal", "123456", "totp", null, "R1"));
        } finally {
            REQUEST.remove();
        }
        assertTrue(hookSaw.contains("identity:req-1"), hookSaw.toString());
        assertTrue(hookSaw.contains("roles:req-1"), hookSaw.toString());
        assertTrue(hookSaw.contains("scopes:req-1"), hookSaw.toString());
        assertEquals(1, hookSaw.stream().filter(s -> s.startsWith("roles:")).count());
    }

    @Test
    void SPEC4_2_tokenWithARefreshTokenRunsNoPartnerHookOnAnyThread() {
        REQUEST.set("req-1");
        try {
            realm().auth().token(TokenRequest.of("R1", "t1"));
        } finally {
            REQUEST.remove();
        }
        assertTrue(hookSaw.isEmpty(), "token() resolves no derived claims (the caller supplies them): " + hookSaw);
    }

    // ---- 3. lock writes are detached from an interrupted caller; 7. a mint while interrupted ----

    private void assertCleanInterruptedRun(Future<?> f, Thread[] worker, String key) throws Exception {
        assertTrue(issuerEntered.await(5, TimeUnit.SECONDS), "the issuer call started");
        worker[0].interrupt();
        f.get(10, TimeUnit.SECONDS);
        assertFalse(store.sawInterrupt.get(), "a lock/outcome write ran on the interrupted thread");
        assertTrue(store.inner.getRefreshResult(SessionKeys.outcomeKey(key)).isPresent(), "the outcome was stored");
        assertTrue(store.inner.acquireRefreshLock(SessionKeys.lockKey(key), Duration.ofSeconds(1)).acquired(),
                "the lock was released");
    }

    @Test
    void SPEC4_3_aCallerInterruptedMidMintStillStoresTheOutcomeAndReleasesTheLockInWithSessionLock() throws Exception {
        verifyDelayMs = 400;
        Realm r = realm();
        ExecutorService ex = Executors.newSingleThreadExecutor();
        Thread[] worker = new Thread[1];
        AtomicBoolean flag = new AtomicBoolean();
        Future<?> f = ex.submit(() -> {
            worker[0] = Thread.currentThread();
            r.auth().mfaVerify(new MFAVerifyRequest("chal", "1", "totp", null, "R1"));
            flag.set(Thread.currentThread().isInterrupted());
        });
        while (worker[0] == null) Thread.sleep(5);
        assertCleanInterruptedRun(f, worker, "R1");
        assertEquals(1, verifyCalls.get());
        assertTrue(flag.get(), "the interrupt status is restored for the caller");
        ex.shutdownNow();
    }

    @Test
    void SPEC4_2_aCallerInterruptedMidMintInTokenStillStoresTheOutcomeAndReleasesTheLock() throws Exception {
        tokenDelayMs = 400;
        Realm r = realm();
        ExecutorService ex = Executors.newSingleThreadExecutor();
        Thread[] worker = new Thread[1];
        AtomicReference<TokenResponse> got = new AtomicReference<>();
        Future<?> f = ex.submit(() -> {
            worker[0] = Thread.currentThread();
            got.set(r.auth().token(TokenRequest.of("R1", "t1")));
        });
        while (worker[0] == null) Thread.sleep(5);
        assertCleanInterruptedRun(f, worker, "R1");
        assertEquals("R2", got.get().refreshToken());
        assertEquals(1, tokenCalls.get());
        ex.shutdownNow();
    }

    // ---- 4. the detached pool is bounded ----

    @Test
    void SPEC6_7_2_aSaturatedDetachedPoolBehavesAsATimeoutAndNamesItsThreads() throws Exception {
        int before = Detached.maxThreads();
        CountDownLatch free = new CountDownLatch(1);
        AtomicReference<String> name = new AtomicReference<>();
        try {
            Detached.setMaxThreads(2);
            ExecutorService ex = Executors.newFixedThreadPool(2);
            List<Future<?>> hung = new ArrayList<>();
            for (int i = 0; i < 2; i++) {
                hung.add(ex.submit(() -> Detached.call(() -> {
                    name.set(Thread.currentThread().getName());
                    free.await();
                    return null;
                }, Duration.ofSeconds(30))));
            }
            Thread.sleep(300);
            long t0 = System.nanoTime();
            assertThrows(java.util.concurrent.TimeoutException.class, () -> Detached.call(() -> "x", Duration.ofSeconds(5)));
            assertTrue((System.nanoTime() - t0) / 1_000_000 < 1_000, "a saturated pool refuses at once, it does not queue");
            assertTrue(name.get().startsWith("realmid-detached"), name.get());

            // a lock path under saturation answers the same 503 a store error does
            RealmException e = assertThrows(RealmException.class,
                    () -> realm().auth().token(TokenRequest.of("R9", "t1")));
            assertEquals(503, e.getHttpStatus());
            assertEquals(0, tokenCalls.get(), "no mint without the outcome read");
            free.countDown();
            for (Future<?> h : hung) h.get(5, TimeUnit.SECONDS);
            ex.shutdownNow();
        } finally {
            free.countDown();
            Detached.setMaxThreads(before);
        }
    }

    @Test
    void SPEC6_7_2_theBuilderConfiguresTheDetachedPoolCeiling() {
        int before = Detached.maxThreads();
        try {
            Realm.builder().sessionStore(store).realmId("01HREALM").apiKey("rk_live_test")
                    .baseUrl(fs.baseUrl).audience("acme.test").maxDetachedThreads(7).build();
            assertEquals(7, Detached.maxThreads());
            assertThrows(IllegalArgumentException.class, () -> Realm.builder().maxDetachedThreads(0));
        } finally {
            Detached.setMaxThreads(before);
        }
    }

    // ---- 6. a tenant-specific 403 is NOT shared across request shapes ----

    @Test
    void SPEC4_2_aTenantSpecific403IsNotSharedWithADifferentShapeWhichMintsForItself() throws Exception {
        List<String> presented = Collections.synchronizedList(new ArrayList<>());
        fs.onJson("POST /auth/token", (body, rec) -> {
            presented.add(body.get("refresh_token") + "/" + body.get("tenant_id"));
            sleep(250);
            if ("t1".equals(body.get("tenant_id"))) {
                return FakeServer.Reply.json(403, Map.of("error", Map.of("code", "forbidden", "message", "not a member of t1")));
            }
            return FakeServer.Reply.json(200, Map.of("access_token", "AT-t2", "refresh_token", "R2", "expires_in", 900,
                    "subject_type", "user", "tenant_id", "t2", "role", "member"));
        });
        Realm r = realm();
        ExecutorService ex = Executors.newFixedThreadPool(2);
        Future<TokenResponse> a = ex.submit(() -> r.auth().token(TokenRequest.of("R1", "t1")));
        Thread.sleep(80);
        Future<TokenResponse> b = ex.submit(() -> r.auth().token(TokenRequest.of("R1", "t2")));
        Exception ea = assertThrows(Exception.class, a::get);
        assertEquals(403, ((RealmException) ea.getCause()).getHttpStatus());
        assertEquals("AT-t2", b.get().accessToken(), "the other shape is not handed t1's 403");
        assertEquals(List.of("R1/t1", "R1/t2"), presented, "the token t1 never spent is re-presented");
        ex.shutdown();
    }

    // ---- 7. the 3-hop give-up and the manager adopting the newest token ----

    private void seedHandOvers() {
        var m = new com.fasterxml.jackson.databind.ObjectMapper();
        assertTrue(SessionLocks.storeMfaOutcome(store.inner, m, "R1", "R2"));
        assertTrue(SessionLocks.storeMfaOutcome(store.inner, m, "R2", "R3"));
        assertTrue(SessionLocks.storeMfaOutcome(store.inner, m, "R3", "R4"));
    }

    @Test
    void SPEC4_2_tokenGivesUpAfterThreeHandOversWithTheNewestTokenAndNeverMints() {
        seedHandOvers();
        RefreshSupersededException e = assertThrows(RefreshSupersededException.class,
                () -> realm().auth().token(TokenRequest.of("R1", "t1")));
        assertEquals("R4", e.refreshToken());
        assertEquals(0, tokenCalls.get());
    }

    @Test
    void SPEC4_2_1_theTokenManagerAdoptsTheNewestTokenFromTheGiveUp() {
        seedHandOvers();
        TokenManager tm = realm().auth().newTokenManager("R1");
        assertThrows(RefreshSupersededException.class, tm::accessToken);
        assertEquals("R4", tm.refreshToken());
        assertEquals(0, tokenCalls.get());
    }

    // ---- 8. SPEC §4.2 "An error after a hand-over carries the newest token" / §4.2.1 adopting ----

    private static final String HOP1 = "HOP1-SECRET-TOKEN";

    /** Delegates to a memory store; can fail the lock of one token, or run a hook when an outcome is read. */
    private static final class HopStore implements dev.realmid.sdk.session.SessionStateStore {
        final dev.realmid.sdk.session.MemorySessionStore inner = new dev.realmid.sdk.session.MemorySessionStore();
        volatile String failLockOf;
        volatile String hookOutcomeOf;
        volatile Runnable hook;
        public void revokeSession(String k, java.time.Instant u) { inner.revokeSession(k, u); }
        public void raiseNotBefore(String k, java.time.Instant nb, java.time.Instant u) { inner.raiseNotBefore(k, nb, u); }
        public List<dev.realmid.sdk.session.SessionState> sessionStates(List<String> k) { return inner.sessionStates(k); }
        public void evict(String p) { inner.evict(p); }
        public RefreshLock acquireRefreshLock(String k, Duration t) {
            if (failLockOf != null && k.equals(SessionKeys.lockKey(failLockOf))) throw new IllegalStateException("store down");
            return inner.acquireRefreshLock(k, t);
        }
        public void putRefreshResult(String k, byte[] r, Duration t) { inner.putRefreshResult(k, r, t); }
        public java.util.Optional<byte[]> getRefreshResult(String k) {
            if (hookOutcomeOf != null && k.equals(SessionKeys.outcomeKey(hookOutcomeOf)) && hook != null) hook.run();
            return inner.getRefreshResult(k);
        }
    }

    private HopStore handedOverStore() {
        HopStore hs = new HopStore();
        assertTrue(SessionLocks.storeMfaOutcome(hs.inner, new com.fasterxml.jackson.databind.ObjectMapper(), "R1", HOP1));
        return hs;
    }

    private Realm realmWith(dev.realmid.sdk.session.SessionStateStore st) {
        return Realm.builder().sessionStore(st).realmId("01HREALM").apiKey("rk_live_test")
                .baseUrl(fs.baseUrl).audience("acme.test").build();
    }

    private void token403() {
        fs.onJson("POST /auth/token", (body, rec) -> FakeServer.Reply.json(403,
                Map.of("error", Map.of("code", "forbidden", "message", "not a member of t1"))));
    }

    @Test
    void SPEC4_2_handover_lockStoreFailureAfterAHandOverCarriesTheHop1Token() {
        HopStore hs = handedOverStore();
        hs.failLockOf = HOP1;
        RefreshHandedOverException e = assertThrows(RefreshHandedOverException.class,
                () -> realmWith(hs).auth().token(TokenRequest.of("R1", "t1")));
        assertEquals(HOP1, e.refreshToken());
        assertEquals(ErrorCode.SERVER_ERROR, e.getCode());
        assertEquals(503, e.getHttpStatus(), "tryOnce reports an unavailable store as 503");
        assertEquals("session store unavailable", e.getMessage());
        assertTrue(e.getCause() instanceof RealmException);
    }

    @Test
    void SPEC4_2_handover_shapeSpecific403AfterAHandOverCarriesTheHop1Token() {
        HopStore hs = handedOverStore();
        token403();
        RefreshHandedOverException e = assertThrows(RefreshHandedOverException.class,
                () -> realmWith(hs).auth().token(TokenRequest.of("R1", "t1")));
        assertEquals(HOP1, e.refreshToken());
        assertEquals(403, e.getHttpStatus());
        assertEquals(ErrorCode.FORBIDDEN, e.getCode());
        assertEquals("not a member of t1", e.getMessage());
        assertTrue(e.getCause() instanceof RealmException);
        assertEquals(403, ((RealmException) e.getCause()).getHttpStatus());
    }

    @Test
    void SPEC4_2_handover_interruptAfterAHandOverCarriesTheHop1Token() {
        HopStore hs = handedOverStore();
        Thread caller = Thread.currentThread();
        hs.hookOutcomeOf = "R1";
        hs.hook = caller::interrupt;
        try {
            RefreshHandedOverException e = assertThrows(RefreshHandedOverException.class,
                    () -> realmWith(hs).auth().token(TokenRequest.of("R1", "t1")));
            assertEquals(HOP1, e.refreshToken());
            assertEquals(503, e.getHttpStatus());
        } finally {
            Thread.interrupted();
        }
    }

    @Test
    void SPEC4_2_handover_aTokenLevelErrorAfterAHandOverCarriesNothing() {
        HopStore hs = handedOverStore();
        fs.onJson("POST /auth/token", (body, rec) -> FakeServer.Reply.json(401,
                Map.of("error", Map.of("code", "refresh_invalid", "message", "dead"))));
        RealmException e = assertThrows(RealmException.class,
                () -> realmWith(hs).auth().token(TokenRequest.of("R1", "t1")));
        assertFalse(e instanceof RefreshHandedOverException, "token-level errors carry nothing");
        assertEquals(401, e.getHttpStatus());
    }

    @Test
    void SPEC4_2_handover_theTokenIsInNoMessageToStringOrSerialization() throws Exception {
        HopStore hs = handedOverStore();
        token403();
        RefreshHandedOverException e = assertThrows(RefreshHandedOverException.class,
                () -> realmWith(hs).auth().token(TokenRequest.of("R1", "t1")));
        assertFalse(String.valueOf(e.getMessage()).contains(HOP1));
        assertFalse(e.toString().contains(HOP1));
        assertFalse(e.getDetails().toString().contains(HOP1));
        var bos = new java.io.ByteArrayOutputStream();
        try (var oos = new java.io.ObjectOutputStream(bos)) { oos.writeObject(e); }
        assertFalse(bos.toString(java.nio.charset.StandardCharsets.ISO_8859_1).contains(HOP1));
    }

    @Test
    void SPEC4_2_handover_hopZeroErrorsAreUnchanged() {
        HopStore hs = new HopStore();
        hs.failLockOf = "R1";
        RealmException e = assertThrows(RealmException.class,
                () -> realmWith(hs).auth().token(TokenRequest.of("R1", "t1")));
        assertFalse(e instanceof RefreshHandedOverException);
        token403();
        RealmException f = assertThrows(RealmException.class,
                () -> realmWith(new HopStore()).auth().token(TokenRequest.of("R1", "t1")));
        assertFalse(f instanceof RefreshHandedOverException);
        assertEquals(403, f.getHttpStatus());
    }

    @Test
    void SPEC4_2_1_adopt_theTokenManagerAdoptsAndPersistsTheHandedOverToken() {
        HopStore hs = handedOverStore();
        hs.failLockOf = HOP1;
        List<String> saved = new ArrayList<>();
        TokenManager tm = realmWith(hs).auth().newTokenManager("R1",
                new TokenManagerOptions().tenantId("t1").refreshSink(saved::add));
        assertThrows(RefreshHandedOverException.class, tm::accessToken);
        assertEquals(HOP1, tm.refreshToken());
        assertEquals(List.of(HOP1), saved);
    }

    @Test
    void SPEC4_2_1_adopt_aSinkFailureThrowsTheOriginalWithTheSaveFailureSuppressed() {
        HopStore hs = handedOverStore();
        hs.failLockOf = HOP1;
        IllegalStateException boom = new IllegalStateException("disk full");
        TokenManager tm = realmWith(hs).auth().newTokenManager("R1",
                new TokenManagerOptions().tenantId("t1").refreshSink(t -> { throw boom; }));
        RefreshHandedOverException e = assertThrows(RefreshHandedOverException.class, tm::accessToken);
        assertEquals(HOP1, e.refreshToken());
        assertEquals(ErrorCode.SERVER_ERROR, e.getCode());
        assertEquals(List.of(boom), List.of(e.getSuppressed()));

        seedHandOvers();
        TokenManager tm2 = realm().auth().newTokenManager("R1",
                new TokenManagerOptions().tenantId("t1").refreshSink(t -> { throw boom; }));
        RefreshSupersededException e2 = assertThrows(RefreshSupersededException.class, tm2::accessToken);
        assertEquals("R4", e2.refreshToken());
        assertEquals(503, e2.getHttpStatus());
        assertEquals(List.of(boom), List.of(e2.getSuppressed()));
    }

    @Test
    void SPEC4_2_1_adopt_suppressedIsNonEmptyAndAnInterruptedSinkReSetsTheInterruptStatus() {
        HopStore hs = handedOverStore();
        hs.failLockOf = HOP1;
        TokenManager tm = realmWith(hs).auth().newTokenManager("R1",
                new TokenManagerOptions().tenantId("t1").refreshSink(t -> { throw new InterruptedException("sink"); }));
        try {
            RefreshHandedOverException e = assertThrows(RefreshHandedOverException.class, tm::accessToken);
            // guards against a RealmException constructor change making addSuppressed a silent no-op
            assertNotEquals(0, e.getSuppressed().length, "the save failure must be attached");
            assertTrue(e.getSuppressed()[0] instanceof InterruptedException);
            assertTrue(Thread.currentThread().isInterrupted(), "the interrupt status is re-set");
        } finally {
            Thread.interrupted();
        }
    }
}
