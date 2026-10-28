package dev.realmid.sdk.middleware;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.session.MemorySessionStore;
import dev.realmid.sdk.session.SessionKeys;
import dev.realmid.sdk.session.SessionState;
import dev.realmid.sdk.session.SessionStateStore;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/** Go 0.64.0 / 0.64.2 middleware parity: the opt-in recovery route (SPEC 10.1 step 5a) and read-error handling. */
class V064MiddlewareTest {

    private static final ObjectMapper M = new ObjectMapper();
    private FakeServer api;
    private final List<String> calls = Collections.synchronizedList(new ArrayList<>());
    private final AtomicInteger recoveryCalls = new AtomicInteger();
    private final AtomicInteger tokenCalls = new AtomicInteger();
    private final List<String> recoveryBodies = Collections.synchronizedList(new ArrayList<>());

    static final class Spy implements SessionStateStore {
        final SessionStateStore inner = new MemorySessionStore();
        final List<String> calls;
        volatile boolean failReads;
        Spy(List<String> calls) { this.calls = calls; }
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

    private Spy store;
    private Realm realm;

    @BeforeEach
    void setUp() throws Exception {
        api = new FakeServer();
        api.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("access_token", "pt", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform")));
        api.on("POST /auth/mfa/recovery", (ex, body) -> {
            recoveryCalls.incrementAndGet();
            recoveryBodies.add(new String(body, StandardCharsets.UTF_8));
            return FakeServer.Reply.json(200, Map.of("access_token", "a", "refresh_token", "RM", "expires_in", 60,
                    "reenroll_required", true, "user", Map.of(), "tenants", List.of()));
        });
        api.on("POST /auth/mfa/verify", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                "access_token", "a", "refresh_token", "RM", "expires_in", 60, "user", Map.of(), "tenants", List.of())));
        api.on("POST /auth/token", (ex, body) -> {
            tokenCalls.incrementAndGet();
            return FakeServer.Reply.json(200, Map.of("access_token", "a", "refresh_token", "R2", "expires_in", 60,
                    "tenant_id", "t1", "role", "member"));
        });
        store = new Spy(calls);
        realm = Realm.builder().sessionStore(store).realmId("01HREALM").apiKey("rk").baseUrl(api.baseUrl)
                .audience("acme.test").build();
    }

    @AfterEach
    void tearDown() { api.close(); }

    private RealmFilterTest.FakeRes call(RealmFilter f, RealmFilterTest.FakeReq req) throws Exception {
        RealmFilterTest.FakeRes res = new RealmFilterTest.FakeRes();
        f.doFilter(req, res, (rq, rs) -> ((jakarta.servlet.http.HttpServletResponse) rs).setStatus(204));
        return res;
    }

    private RealmFilterTest.FakeReq post(String path, String cookie, String json) {
        RealmFilterTest.FakeReq r = new RealmFilterTest.FakeReq("POST", path);
        if (cookie != null) r.headers.put("Cookie", new ArrayList<>(List.of("realmid_refresh=" + cookie)));
        r.body = json.getBytes(StandardCharsets.UTF_8);
        return r;
    }

    private static String text(RealmFilterTest.FakeRes r) { return new String(r.bytes(), StandardCharsets.UTF_8); }

    private RealmFilter filter(String recoveryPath) {
        MiddlewareConfig.Builder b = realm.middleware().tokenDelivery(TokenDelivery.COOKIE).refreshWait(10, 50);
        if (recoveryPath != null) b.recoveryPath(recoveryPath);
        return b.buildFilter();
    }

    @Test
    void SPEC10_1_5a_recoveryRouteIsOffByDefaultAndAnUnsetPathMatchesNothing() throws Exception {
        RealmFilterTest.FakeRes r = call(filter(null), post("/mfa/recovery", "R1", "{\"challenge_token\":\"c\",\"code\":\"x\"}"));
        assertEquals(401, r.status, text(r)); // fell through to the bearer check
        assertEquals(0, recoveryCalls.get());
    }

    @Test
    void SPEC10_1_5a_recoveryRouteRedeemsUnderTheSessionLockWithTheMfaVerifyFingerprint() throws Exception {
        RealmFilterTest.FakeRes r = call(filter("/mfa/recovery"),
                post("/mfa/recovery", "R1", "{\"mfa_challenge_token\":\"c\",\"code\":\"abcd\"}"));
        assertEquals(200, r.status, text(r));
        @SuppressWarnings("unchecked") Map<String, Object> body = M.readValue(r.bytes(), Map.class);
        assertEquals(Boolean.TRUE, body.get("reenroll_required"));
        assertNull(body.get("access_token"), "R44: recovery never surfaces an access token");
        assertTrue(recoveryBodies.get(0).contains("\"mfa_challenge_token\":\"c\""), recoveryBodies.get(0));
        // lock taken exactly once (the handler does NOT pass refreshToken: not re-entrant), outcome stored
        assertEquals(1, calls.stream().filter(c -> c.startsWith("lock ")).count(), calls.toString());
        String put = calls.stream().filter(c -> c.startsWith("put ")).findFirst().orElseThrow();
        assertTrue(put.startsWith("put " + SessionKeys.outcomeKey("R1")), put);
        assertTrue(put.contains("\"fp\":\"mfa-verify\"") && put.contains("\"refresh_token\":\"RM\""), put);
        assertTrue(r.getHeaders("Set-Cookie").stream().anyMatch(c -> c.startsWith("realmid_refresh=RM")));
    }

    @Test
    void SPEC10_1_5a_recoveryAcceptsChallengeTokenAndCamelCaseSpellings() throws Exception {
        RealmFilter f = filter("/mfa/recovery");
        assertEquals(200, call(f, post("/mfa/recovery", null, "{\"challenge_token\":\"c\",\"code\":\"x\"}")).status);
        assertEquals(200, call(f, post("/mfa/recovery", null, "{\"challengeToken\":\"c\",\"code\":\"x\"}")).status);
        assertTrue(recoveryBodies.stream().allMatch(b -> b.contains("\"mfa_challenge_token\":\"c\"")), recoveryBodies.toString());
    }

    @Test
    void SPEC4_3_middlewareHandlersNeverSetRefreshTokenOnTheirDirectCallsBecauseTheLockIsNotReentrant() throws Exception {
        RealmFilter f = filter("/mfa/recovery");
        // If a handler set refreshToken the direct call would try to take the lock it already holds,
        // wait out the budget and answer 503 "refresh in progress".
        assertEquals(200, call(f, post("/mfa/verify", "R1", "{\"challenge_token\":\"c\",\"code\":\"1\"}")).status);
        assertEquals(200, call(f, post("/mfa/recovery", "R1", "{\"challenge_token\":\"c\",\"code\":\"1\"}")).status);
        assertEquals(2, calls.stream().filter(c -> c.startsWith("lock ")).count(), calls.toString());
    }

    @Test
    void SPEC10_1_4a_anOutcomeReadErrorOnRefreshIs503AndNeverMints() throws Exception {
        store.failReads = true;
        RealmFilterTest.FakeRes r = call(filter(null),
                post("/token", "R1", "{\"tenant_id\":\"t1\"}"));
        assertEquals(503, r.status, text(r));
        assertTrue(text(r).contains("server_error"), text(r));
        assertEquals(0, tokenCalls.get(), "a read error must not re-present a possibly spent token");
    }
}
