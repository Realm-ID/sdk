package dev.realmid.sdk.auth;

import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import dev.realmid.sdk.session.MemorySessionStore;
import dev.realmid.sdk.session.SessionKeys;
import dev.realmid.sdk.session.SessionState;
import dev.realmid.sdk.session.SessionStateStore;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Go 0.64.0 / 0.64.2 parity (SPEC 4.2, 4.3, 4.3a): recovery-code redeem, the
 * optional per-session lock on direct MFA calls, and {@code token()} under the
 * same lock.
 */
class V064DirectLockTest {

    private FakeServer fs;
    private final List<String> calls = Collections.synchronizedList(new ArrayList<>());
    private final List<String> bodies = Collections.synchronizedList(new ArrayList<>());
    private final List<IdentityResolvedEvent> fired = new ArrayList<>();
    private final AtomicInteger tokenCalls = new AtomicInteger();
    private volatile long tokenDelayMs = 0;
    private MemorySessionStore mem;
    private Spy store;

    /** Records the store calls and can be told to fail reads. */
    static final class Spy implements SessionStateStore {
        final SessionStateStore inner;
        final List<String> calls;
        volatile boolean failReads;
        Spy(SessionStateStore inner, List<String> calls) { this.inner = inner; this.calls = calls; }
        public void revokeSession(String k, Instant u) { inner.revokeSession(k, u); }
        public void raiseNotBefore(String k, Instant nb, Instant u) { inner.raiseNotBefore(k, nb, u); }
        public List<SessionState> sessionStates(List<String> k) { return inner.sessionStates(k); }
        public void evict(String p) { inner.evict(p); }
        public RefreshLock acquireRefreshLock(String k, Duration ttl) { calls.add("lock " + k); return inner.acquireRefreshLock(k, ttl); }
        public void putRefreshResult(String k, byte[] r, Duration ttl) {
            calls.add("put " + k + " " + new String(r, StandardCharsets.UTF_8));
            inner.putRefreshResult(k, r, ttl);
        }
        public Optional<byte[]> getRefreshResult(String k) {
            if (failReads) throw new IllegalStateException("redis down");
            return inner.getRefreshResult(k);
        }
    }

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        fs.onJson("POST /auth/login", (body, rec) -> FakeServer.Reply.json(200, Map.of(
                "access_token", "pt-12345", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform")));
        Map<String, Object> session = Map.of("access_token", "at", "refresh_token", "ROTATED", "expires_in", 60,
                "user", Map.of("id", "u1"), "tenants", List.of(Map.of("tenant_id", "t1", "role", "owner")));
        fs.onJson("POST /auth/mfa/verify", (body, rec) -> {
            bodies.add(FakeServer.M.valueToTree(body).toString());
            return FakeServer.Reply.json(200, session);
        });
        fs.onJson("POST /auth/mfa/recovery", (body, rec) -> {
            bodies.add(FakeServer.M.valueToTree(body).toString());
            return FakeServer.Reply.json(200, session);
        });
        mem = new MemorySessionStore();
        store = new Spy(mem, calls);
    }

    @AfterEach
    void tearDown() { fs.close(); }

    private Realm realm() {
        return Realm.builder().sessionStore(store).realmId("01HREALM").apiKey("rk_live_test")
                .baseUrl(fs.baseUrl).audience("acme.test").onIdentityResolved(fired::add).build();
    }

    // ---- 4.3a redeemRecoveryCode ----

    @Test
    void SPEC4_3a_redeemRecoveryCodePostsTheRecoveryBodyAndSetsReenrollRequired() {
        fs.onJson("POST /auth/mfa/recovery", (body, rec) -> {
            bodies.add(FakeServer.M.valueToTree(body).toString());
            return FakeServer.Reply.json(200, Map.of("access_token", "at", "refresh_token", "R2", "expires_in", 60,
                    "reenroll_required", true, "user", Map.of("id", "u1"),
                    "tenants", List.of(Map.of("tenant_id", "t1", "role", "owner"))));
        });
        Session s = realm().auth().redeemRecoveryCode(RedeemRecoveryCodeRequest.of("chal", "abcd-efgh"));
        assertTrue(s.reenrollRequired());
        assertEquals(1, bodies.size());
        assertTrue(bodies.get(0).contains("\"mfa_challenge_token\":\"chal\""), bodies.get(0));
        assertTrue(bodies.get(0).contains("\"code\":\"abcd-efgh\""), bodies.get(0));
        assertTrue(bodies.get(0).contains("\"realm_id\":\"01HREALM\""), bodies.get(0));
        assertFalse(bodies.get(0).contains("refresh"), bodies.get(0));
    }

    @Test
    void SPEC4_3a_recoveryFiresTheDistinctMfaRecoveryFlowNotMfaVerify() {
        realm().auth().redeemRecoveryCode(RedeemRecoveryCodeRequest.of("chal", "c"));
        assertEquals(1, fired.size());
        assertEquals(AuthFlow.MFA_RECOVERY, fired.get(0).flow());
        assertEquals("mfa_recovery", AuthFlow.MFA_RECOVERY.wire());
    }

    @Test
    void SPEC4_3a_mfaVerifySessionHasReenrollRequiredFalse() {
        Session s = realm().auth().mfaVerify(MFAVerifyRequest.of("chal", "123456"));
        assertFalse(s.reenrollRequired());
    }

    // ---- 4.3 / 4.3a optional refreshToken ----

    @Test
    void SPEC4_3_mfaVerifyWithRefreshTokenTakesTheLockStoresTheMfaVerifyOutcomeAndNeverSendsIt() {
        realm().auth().mfaVerify(new MFAVerifyRequest("chal", "123456", "totp", null, "R1"));
        assertTrue(calls.get(0).startsWith("lock " + SessionKeys.lockKey("R1")), calls.toString());
        String put = calls.stream().filter(c -> c.startsWith("put ")).findFirst().orElseThrow();
        assertTrue(put.startsWith("put " + SessionKeys.outcomeKey("R1")), put);
        assertTrue(put.contains("\"fp\":\"mfa-verify\""), put);
        assertTrue(put.contains("\"refresh_token\":\"ROTATED\""), put);
        assertFalse(bodies.get(0).contains("R1"), "the refresh token is never sent on the wire: " + bodies.get(0));
        // released
        assertTrue(mem.acquireRefreshLock(SessionKeys.lockKey("R1"), Duration.ofSeconds(1)).acquired());
    }

    @Test
    void SPEC4_3_mfaVerifyWithoutRefreshTokenTakesNoLockAndStoresNothing() {
        realm().auth().mfaVerify(MFAVerifyRequest.of("chal", "123456"));
        assertTrue(calls.isEmpty(), calls.toString());
    }

    @Test
    void SPEC4_3_mfaVerifyOtpAndRecoveryAlsoTakeTheLockWhenGivenARefreshToken() {
        Realm r = realm();
        r.auth().mfaVerifyOtp(new MfaVerifyOtpRequest("chal", "123456", null, "R1"));
        r.auth().redeemRecoveryCode(new RedeemRecoveryCodeRequest("chal", "c", null, "R2"));
        assertTrue(calls.stream().anyMatch(c -> c.startsWith("lock " + SessionKeys.lockKey("R1"))), calls.toString());
        assertTrue(calls.stream().anyMatch(c -> c.startsWith("lock " + SessionKeys.lockKey("R2"))), calls.toString());
        assertTrue(calls.stream().anyMatch(c -> c.startsWith("put " + SessionKeys.outcomeKey("R2"))), calls.toString());
    }

    @Test
    void SPEC4_3_lockHeldPastTheWaitBudgetIs503RefreshInProgressAndTheIssuerIsNotCalled() {
        mem.acquireRefreshLock(SessionKeys.lockKey("R1"), Duration.ofSeconds(30));
        Realm r = realm();
        r.auth().setLockWait(2, 5);
        RealmException e = assertThrows(RealmException.class,
                () -> r.auth().mfaVerify(new MFAVerifyRequest("chal", "1", "totp", null, "R1")));
        assertEquals(ErrorCode.SERVER_ERROR, e.getCode());
        assertEquals(503, e.getHttpStatus());
        assertTrue(e.getMessage().contains("refresh in progress"), e.getMessage());
        assertTrue(bodies.isEmpty());
    }

    @Test
    void SPEC4_3_aCancelledCallerWaitingOnTheLockFailsClosedWithoutCallingTheIssuer() {
        mem.acquireRefreshLock(SessionKeys.lockKey("R1"), Duration.ofSeconds(30));
        Realm r = realm();
        Thread.currentThread().interrupt();
        try {
            assertThrows(RealmException.class,
                    () -> r.auth().redeemRecoveryCode(new RedeemRecoveryCodeRequest("c", "c", null, "R1")));
            assertTrue(Thread.currentThread().isInterrupted(), "interrupt status is restored");
        } finally {
            Thread.interrupted();
        }
        assertTrue(bodies.isEmpty());
    }

    // ---- 4.2 token() under the lock (go 0.64.2) ----

    private void issuer(String rotatedTo) {
        fs.onJson("POST /auth/token", (body, rec) -> {
            tokenCalls.incrementAndGet();
            try { if (tokenDelayMs > 0) Thread.sleep(tokenDelayMs); } catch (InterruptedException ignored) { }
            return FakeServer.Reply.json(200, Map.of("access_token", "AT-" + body.get("tenant_id"),
                    "refresh_token", rotatedTo, "expires_in", 900, "subject_type", "user",
                    "tenant_id", String.valueOf(body.get("tenant_id")), "role", "member"));
        });
    }

    @Test
    void SPEC4_2_tokenWithARefreshTokenTakesTheSessionLockAndStoresItsOutcome() {
        issuer("R2");
        TokenResponse t = realm().auth().token(TokenRequest.of("R1", "t1"));
        assertEquals("R2", t.refreshToken());
        assertTrue(calls.get(0).startsWith("lock " + SessionKeys.lockKey("R1")), calls.toString());
        assertTrue(calls.stream().anyMatch(c -> c.startsWith("put " + SessionKeys.outcomeKey("R1"))), calls.toString());
    }

    @Test
    void SPEC4_2_concurrentIdenticalTokenCallsMintOnceAndTheLoserAdoptsTheWinnersResult() throws Exception {
        issuer("R2");
        tokenDelayMs = 300;
        Realm r = realm();
        ExecutorService ex = Executors.newFixedThreadPool(2);
        Future<TokenResponse> a = ex.submit(() -> r.auth().token(TokenRequest.of("R1", "t1")));
        Thread.sleep(80);
        Future<TokenResponse> b = ex.submit(() -> r.auth().token(TokenRequest.of("R1", "t1")));
        assertEquals("AT-t1", a.get().accessToken());
        assertEquals("AT-t1", b.get().accessToken());
        assertEquals("R2", b.get().refreshToken());
        assertEquals(1, tokenCalls.get(), "the issuer is called once");
        ex.shutdown();
    }

    @Test
    void SPEC4_2_aDifferentTenantLoserRetriesOnTheWinnersRotatedTokenNeverTheSpentOne() throws Exception {
        List<String> presented = Collections.synchronizedList(new ArrayList<>());
        fs.onJson("POST /auth/token", (body, rec) -> {
            presented.add(body.get("refresh_token") + "/" + body.get("tenant_id"));
            try { Thread.sleep(250); } catch (InterruptedException ignored) { }
            String next = "R1".equals(body.get("refresh_token")) ? "R2" : "R3";
            return FakeServer.Reply.json(200, Map.of("access_token", "AT-" + body.get("tenant_id"),
                    "refresh_token", next, "expires_in", 900, "tenant_id", String.valueOf(body.get("tenant_id")),
                    "role", "member"));
        });
        Realm r = realm();
        ExecutorService ex = Executors.newFixedThreadPool(2);
        Future<TokenResponse> a = ex.submit(() -> r.auth().token(TokenRequest.of("R1", "t1")));
        Thread.sleep(80);
        Future<TokenResponse> b = ex.submit(() -> r.auth().token(TokenRequest.of("R1", "t2")));
        assertEquals("AT-t1", a.get().accessToken());
        assertEquals("AT-t2", b.get().accessToken());
        assertEquals(List.of("R1/t1", "R2/t2"), presented, "the loser never re-presents the spent R1");
        ex.shutdown();
    }

    @Test
    void SPEC4_2_aTokenLevel401IsSharedAcrossRequestShapesButATenantSpecific403IsNot() throws Exception {
        AtomicInteger n = new AtomicInteger();
        fs.onJson("POST /auth/token", (body, rec) -> {
            n.incrementAndGet();
            try { Thread.sleep(250); } catch (InterruptedException ignored) { }
            return FakeServer.Reply.json(401, Map.of("error", Map.of("code", "refresh_invalid", "message", "dead")));
        });
        Realm r = realm();
        ExecutorService ex = Executors.newFixedThreadPool(2);
        Future<TokenResponse> a = ex.submit(() -> r.auth().token(TokenRequest.of("R1", "t1")));
        Thread.sleep(80);
        Future<TokenResponse> b = ex.submit(() -> r.auth().token(TokenRequest.of("R1", "t2")));
        for (Future<TokenResponse> f : List.of(a, b)) {
            Exception e = assertThrows(Exception.class, f::get);
            assertEquals(ErrorCode.REFRESH_INVALID, ((RealmException) e.getCause()).getCode());
        }
        assertEquals(1, n.get(), "a dead token is dead for every shape: one issuer call");
        ex.shutdown();
    }

    @Test
    void SPEC4_2_tokenWhoseOutcomeReadFailsIs503AndNeverMints() {
        issuer("R2");
        store.failReads = true;
        RealmException e = assertThrows(RealmException.class, () -> realm().auth().token(TokenRequest.of("R1", "t1")));
        assertEquals(503, e.getHttpStatus());
        assertEquals(ErrorCode.SERVER_ERROR, e.getCode());
        assertEquals(0, tokenCalls.get(), "a read error must not re-present a possibly spent token");
    }

    @Test
    void SPEC4_2_tokenWithNoRefreshTokenIsNotLocked() {
        issuer("R2");
        realm().auth().token(TokenRequest.of("", "t1"));
        assertEquals(1, tokenCalls.get());
        assertTrue(calls.isEmpty(), calls.toString());
    }

    @Test
    void SPEC4_2_theSupersededGiveUpIsATypedErrorThatRedactsTheToken() {
        RefreshSupersededException e = new RefreshSupersededException("LIVE-SECRET-TOKEN");
        assertEquals("LIVE-SECRET-TOKEN", e.refreshToken());
        assertEquals(ErrorCode.SERVER_ERROR, e.getCode());
        assertEquals(503, e.getHttpStatus());
        assertFalse(e.toString().contains("LIVE-SECRET-TOKEN"));
        assertFalse(String.valueOf(e.getMessage()).contains("LIVE-SECRET-TOKEN"));
        assertFalse(String.valueOf(e.getDetails()).contains("LIVE-SECRET-TOKEN"));
        assertTrue(e instanceof RealmException);
    }

    @Test
    void SPEC4_2_theTokenManagerSerializesOnTheSameLock() {
        issuer("R2");
        TokenManager tm = realm().auth().newTokenManager("R1");
        assertFalse(tm.accessToken().isEmpty());
        assertTrue(calls.stream().anyMatch(c -> c.startsWith("lock " + SessionKeys.lockKey("R1"))), calls.toString());
    }
}
