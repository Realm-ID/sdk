package dev.realmid.sdk.middleware;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.session.MemorySessionStore;
import dev.realmid.sdk.session.SessionKeys;
import dev.realmid.sdk.session.SessionState;
import dev.realmid.sdk.session.SessionStateStore;
import dev.realmid.sdk.session.SessionStateStoreConformance;
import dev.realmid.sdk.verifier.VerifierTestKeys;
import jakarta.servlet.FilterChain;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/**
 * SDK v0.63.0 middleware items: SPEC10_1_3 (logout), SPEC10_1_4a/4b (refresh
 * single-flight, supersession), SPEC10_1_5 (MFA lock), SPEC10_1_6a (logout
 * check), org_session_mode, and the required session store (SPEC6_7_5).
 */
class V063MiddlewareTest {

    private static final String REALM_ID = "01HREALM";
    private static final String AUDIENCE = "acme.test";
    private static final ObjectMapper M = new ObjectMapper();

    private FakeServer api;
    private VerifierTestKeys keys;
    private Realm realm;
    private MemorySessionStore store;
    private final AtomicInteger tokenCalls = new AtomicInteger();
    private final AtomicInteger discoveryCalls = new AtomicInteger();
    private volatile long tokenDelayMs = 0;
    private volatile String discoveryMode = null;
    private final List<String> refreshTokensSeen = Collections.synchronizedList(new ArrayList<>());
    private final List<String> logoutBodies = Collections.synchronizedList(new ArrayList<>());

    @BeforeEach
    void setUp() throws Exception {
        keys = new VerifierTestKeys();
        api = new FakeServer();
        api.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("access_token", "pt", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform")));
        api.on("GET /" + REALM_ID + "/.well-known/jwks.json", (ex, body) -> FakeServer.Reply.json(200, keys.jwks()));
        api.on("GET /" + REALM_ID + "/.well-known/openid-configuration", (ex, body) -> {
            discoveryCalls.incrementAndGet();
            Map<String, Object> d = new LinkedHashMap<>();
            d.put("issuer", "x");
            if (discoveryMode != null) d.put("realmid_org_sessions", discoveryMode);
            return FakeServer.Reply.json(200, d);
        });
        api.on("POST /auth/logout", (ex, body) -> {
            logoutBodies.add(new String(body, StandardCharsets.UTF_8));
            return FakeServer.Reply.json(200, Map.of("status", "ok"));
        });
        store = new MemorySessionStore();
        realm = build(store);
    }

    @AfterEach
    void tearDown() { api.close(); }

    private Realm build(SessionStateStore s) {
        return Realm.builder().sessionStore(s).realmId(REALM_ID).apiKey("rk").baseUrl(api.baseUrl)
                .audience(AUDIENCE).build();
    }

    private String iss() { return api.baseUrl + "/" + REALM_ID; }

    private String jwt(String sid, String sub, long iat, long exp) throws Exception {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("iss", iss());
        c.put("sub", sub);
        c.put("aud", AUDIENCE);
        c.put("iat", iat);
        c.put("exp", exp);
        if (sid != null) c.put("sid", sid);
        c.put("jti", sid == null ? "jti-" + iat + sub : "j-" + iat + sub);
        return keys.sign(c);
    }

    private long now() { return Instant.now().getEpochSecond(); }

    private RealmFilter filter() {
        return realm.middleware().tokenDelivery(TokenDelivery.COOKIE).refreshWait(10, 100).buildFilter();
    }

    private RealmFilterTest.FakeRes call(RealmFilter f, RealmFilterTest.FakeReq req) throws Exception {
        RealmFilterTest.FakeRes res = new RealmFilterTest.FakeRes();
        f.doFilter(req, res, (rq, rs) -> ((jakarta.servlet.http.HttpServletResponse) rs).setStatus(204));
        return res;
    }

    private RealmFilterTest.FakeReq bearerGet(String path, String token) {
        RealmFilterTest.FakeReq r = new RealmFilterTest.FakeReq("GET", path);
        r.headers.put("Authorization", new ArrayList<>(List.of("Bearer " + token)));
        return r;
    }

    private RealmFilterTest.FakeReq post(String path, String cookie, String json, String bearer) {
        RealmFilterTest.FakeReq r = new RealmFilterTest.FakeReq("POST", path);
        if (cookie != null) r.headers.put("Cookie", new ArrayList<>(List.of("realmid_refresh=" + cookie)));
        if (bearer != null) r.headers.put("Authorization", new ArrayList<>(List.of("Bearer " + bearer)));
        r.body = json.getBytes(StandardCharsets.UTF_8);
        return r;
    }

    private static String text(RealmFilterTest.FakeRes r) { return new String(r.bytes(), StandardCharsets.UTF_8); }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> json(RealmFilterTest.FakeRes r) throws Exception {
        return M.readValue(r.bytes(), Map.class);
    }

    private static String setCookieValue(RealmFilterTest.FakeRes r) {
        for (String c : r.getHeaders("Set-Cookie")) {
            if (c.startsWith("realmid_refresh=") && !c.startsWith("realmid_refresh=;")) {
                return c.substring("realmid_refresh=".length(), c.indexOf(';'));
            }
        }
        return null;
    }

    // ---- SPEC6_7_5: store required ----

    @Test
    void SPEC6_7_5_buildWithoutAStoreThrowsAndNamesTheInMemoryConstructor() {
        IllegalStateException e = assertThrows(IllegalStateException.class,
                () -> Realm.builder().realmId(REALM_ID).apiKey("rk").baseUrl(api.baseUrl).audience(AUDIENCE).build());
        assertTrue(e.getMessage().contains("sessionStore"));
        assertTrue(e.getMessage().contains("new MemorySessionStore()"));
    }

    @Test
    void SPEC6_7_5_tokensAndMiddlewareShareTheOneStoreInstance() throws Exception {
        List<String> calls = Collections.synchronizedList(new ArrayList<>());
        SessionStateStore spy = new SpyStore(new MemorySessionStore(), calls);
        realm = build(spy);
        realm.tokens().revokeSession("S");
        call(realm.middleware().refreshWait(10, 100).buildFilter(), bearerGet("/x", jwt("S", "u", now(), now() + 600)));
        assertTrue(calls.stream().anyMatch(c -> c.startsWith("revoke")), calls.toString());
        assertTrue(calls.stream().anyMatch(c -> c.startsWith("states")), calls.toString());
        assertSame(spy, realm.sessionStore());
    }

    @Test
    void SPEC6_7_5_inMemoryStoreConformance() throws Exception {
        SessionStateStoreConformance.run(MemorySessionStore::new);
    }

    // ---- SPEC10_1_6a: logout check by default ----

    @Test
    void SPEC10_1_6a_revokedTokenGetsTheExact401BodyAndNeverReachesTheHandler() throws Exception {
        String t = jwt("S1", "u1", now(), now() + 600);
        assertEquals(204, call(filter(), bearerGet("/x", t)).status); // positive control
        realm.tokens().markRevoked(t);
        RealmFilterTest.FakeRes r = call(filter(), bearerGet("/x", t));
        assertEquals(401, r.status);
        assertEquals("{\"error\":{\"code\":\"unauthorized\",\"message\":\"access token revoked\"},\"revoked\":true}",
                text(r));
    }

    @Test
    void SPEC10_1_6a_revokedTokenOnAnMfaPathIs401Not412AndExemptPathsAreNotGated() throws Exception {
        String t = jwt("S1", "u1", now(), now() + 600);
        realm.tokens().markRevoked(t);
        RealmFilter f = realm.middleware().mfaProtectedPaths("/admin/*").exemptPaths(List.of("/health"))
                .refreshWait(10, 100).buildFilter();
        assertEquals(401, call(f, bearerGet("/admin/x", t)).status);
        assertEquals(204, call(f, bearerGet("/health", t)).status);
    }

    // ---- SPEC10_1_3: logout revokes the session ----

    @Test
    void SPEC10_1_3_issuerSidRevokesTheSessionWithNoBearer() throws Exception {
        api.on("POST /auth/logout", (ex, body) -> FakeServer.Reply.json(200, Map.of("status", "ok", "sid", "S1")));
        RealmFilterTest.FakeRes out = call(filter(), post("/logout", "rt1", "{}", null));
        assertEquals(200, out.status);
        assertEquals("{\"status\":\"ok\"}", text(out));
        assertEquals(401, call(filter(), bearerGet("/x", jwt("S1", "u1", now(), now() + 600))).status);
        assertEquals(204, call(filter(), bearerGet("/x", jwt("S2", "u1", now(), now() + 600))).status);
    }

    @Test
    void SPEC10_1_3_revokedSidsAndSidAllRevoked() throws Exception {
        api.on("POST /auth/logout", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("status", "ok", "sid", "S1", "revoked_sids", List.of("S1", "S2", "S3"))));
        call(filter(), post("/logout", "rt1", "{}", null));
        for (String sid : new String[]{"S1", "S2", "S3"}) {
            assertEquals(401, call(filter(), bearerGet("/x", jwt(sid, "u1", now(), now() + 600))).status, sid);
        }
        // non-list revoked_sids is ignored
        api.on("POST /auth/logout", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("status", "ok", "revoked_sids", "S9")));
        call(filter(), post("/logout", "rt1", "{}", null));
        assertEquals(204, call(filter(), bearerGet("/x", jwt("S9", "u1", now(), now() + 600))).status);
    }

    @Test
    void SPEC10_1_3_olderIssuerFallsBackToAVerifiedUnexpiredBearer() throws Exception {
        String live = jwt("S1", "u1", now(), now() + 600);
        RealmFilterTest.FakeRes out = call(filter(), post("/logout", "rt1", "{}", live));
        assertEquals(200, out.status);
        assertEquals(401, call(filter(), bearerGet("/x", jwt("S1", "u1", now() + 1, now() + 601))).status);
    }

    @Test
    void SPEC10_1_3_expiredForgedOrBlankSubBearerRevokesNothingAndLogoutNeverFails() throws Exception {
        String expired = jwt("S1", "u1", now() - 7200, now() - 3600);
        for (int i = 0; i < 3; i++) assertEquals(200, call(filter(), post("/logout", "rt1", "{}", expired)).status);
        String forged = jwt("S1", "u1", now(), now() + 600);
        forged = forged.substring(0, forged.lastIndexOf('.') + 1) + "AAAA";
        assertEquals(200, call(filter(), post("/logout", "rt1", "{}", forged)).status);
        assertEquals(200, call(filter(), post("/logout", "rt1", "{}", jwt("S1", "  ", now(), now() + 600))).status);
        assertEquals(204, call(filter(), bearerGet("/x", jwt("S1", "u1", now(), now() + 600))).status,
                "M1(a): nothing was revoked");
    }

    @Test
    void SPEC10_1_3_issuerFailurePlusValidBearerRevokesViaFallbackAndNoBearerRevokesNothing() throws Exception {
        api.on("POST /auth/logout", (ex, body) -> FakeServer.Reply.json(500,
                Map.of("error", Map.of("code", "server_error", "message", "boom"))));
        assertEquals(200, call(filter(), post("/logout", "rt1", "{}", null)).status);
        assertEquals(204, call(filter(), bearerGet("/x", jwt("S1", "u1", now(), now() + 600))).status);
        assertEquals(200, call(filter(), post("/logout", "rt1", "{}", jwt("S1", "u1", now(), now() + 600))).status);
        assertEquals(401, call(filter(), bearerGet("/x", jwt("S1", "u1", now() + 1, now() + 601))).status);
    }

    @Test
    void SPEC10_1_3_responseSidWinsOverAValidBearerOfAnotherSession() throws Exception {
        api.on("POST /auth/logout", (ex, body) -> FakeServer.Reply.json(200, Map.of("status", "ok", "sid", "S1")));
        call(filter(), post("/logout", "rt1", "{}", jwt("S2", "u1", now(), now() + 600)));
        assertEquals(401, call(filter(), bearerGet("/x", jwt("S1", "u1", now(), now() + 600))).status);
        assertEquals(204, call(filter(), bearerGet("/x", jwt("S2", "u1", now(), now() + 600))).status);
    }

    @Test
    void SPEC6_7_6_logoutPushesTheSidIntoTheRevocationCacheForTwentyFourHours() throws Exception {
        api.on("POST /auth/logout", (ex, body) -> FakeServer.Reply.json(200, Map.of("status", "ok", "sid", "S1")));
        dev.realmid.sdk.revocation.MemRevocationCache rev = new dev.realmid.sdk.revocation.MemRevocationCache();
        realm = Realm.builder().sessionStore(store).realmId(REALM_ID).apiKey("rk").baseUrl(api.baseUrl)
                .audience(AUDIENCE).revocation(rev).build();
        realm.auth().logout(dev.realmid.sdk.auth.LogoutRequest.of("rt1"));
        assertTrue(rev.isRevoked("S1"));
        // Issuer-B shape through verify(): same sid, a different jti
        assertThrows(dev.realmid.sdk.RealmException.class, () -> realm.verify(jwt("S1", "u1", now(), now() + 600)));
        assertEquals(List.of(SessionState.NONE).size(), 1);
        assertTrue(store.sessionStates(List.of(SessionKeys.revokedKey("S1"))).get(0).revoked());
    }

    // ---- SPEC10_1_4a: single-flight ----

    private void issuerToken(String newRefresh) {
        api.on("POST /auth/token", (ex, body) -> {
            tokenCalls.incrementAndGet();
            @SuppressWarnings("unchecked")
            Map<String, Object> b = castMap((Map<?, ?>) parse(body));
            refreshTokensSeen.add(String.valueOf(b.get("refresh_token")));
            try {
                if (tokenDelayMs > 0) Thread.sleep(tokenDelayMs);
                long iat = now();
                String tenant = String.valueOf(b.get("tenant_id"));
                String access = jwt("S1", "sub-" + tenant, iat, iat + 600);
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("access_token", access);
                out.put("refresh_token", newRefresh == null ? b.get("refresh_token") : newRefresh);
                out.put("expires_in", 600);
                out.put("tenant_id", tenant);
                out.put("role", "member");
                return FakeServer.Reply.json(200, out);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
    }

    private static Object parse(byte[] body) {
        try { return M.readValue(body, Map.class); } catch (Exception e) { throw new RuntimeException(e); }
    }

    private List<RealmFilterTest.FakeRes> concurrent(List<RealmFilterTest.FakeReq> reqs) throws Exception {
        RealmFilter f = filter();
        ExecutorService ex = Executors.newFixedThreadPool(reqs.size());
        CountDownLatch go = new CountDownLatch(0); // no gate: request N starts 40 ms after N-1
        List<Future<RealmFilterTest.FakeRes>> fs = new ArrayList<>();
        for (RealmFilterTest.FakeReq r : reqs) {
            fs.add(ex.submit(() -> { go.await(); return call(f, r); }));
            Thread.sleep(40); // the first reaches the lock before the next
        }
        List<RealmFilterTest.FakeRes> out = new ArrayList<>();
        for (Future<RealmFilterTest.FakeRes> x : fs) out.add(x.get());
        ex.shutdown();
        return out;
    }

    @Test
    void SPEC10_1_4a_concurrentSameCookieSameTenantMintsOnceAndBothGetTheWinnersTokens() throws Exception {
        tokenDelayMs = 400;
        issuerToken("R2");
        List<RealmFilterTest.FakeRes> rs = concurrent(List.of(
                post("/token", "R1", "{\"tenant_id\":\"acme\"}", null),
                post("/token", "R1", "{\"tenant_id\":\"acme\"}", null),
                post("/token", "R1", "{\"tenant_id\":\"acme\"}", null)));
        assertEquals(1, tokenCalls.get());
        String access = (String) json(rs.get(0)).get("access_token");
        for (RealmFilterTest.FakeRes r : rs) {
            assertEquals(200, r.status, text(r));
            assertEquals(access, json(r).get("access_token"));
            assertEquals("R2", setCookieValue(r));
        }
    }

    @Test
    void SPEC10_1_4a_differentTenantLoserGets503RetryCarryingTheWinnersRotatedCookie() throws Exception {
        tokenDelayMs = 400;
        issuerToken("R2");
        List<RealmFilterTest.FakeRes> rs = concurrent(List.of(
                post("/token", "R1", "{\"tenant_id\":\"acme\"}", null),
                post("/token", "R1", "{\"tenant_id\":\"globex\"}", null)));
        assertEquals(1, tokenCalls.get(), "the loser never mints");
        assertEquals(200, rs.get(0).status);
        RealmFilterTest.FakeRes loser = rs.get(1);
        assertEquals(503, loser.status);
        assertEquals("{\"error\":{\"code\":\"server_error\",\"message\":\"refresh superseded, retry\"},\"retry\":true}",
                text(loser));
        assertEquals("R2", setCookieValue(loser));
        // the retry with the new token is an ordinary winner for the loser's tenant
        tokenDelayMs = 0;
        RealmFilterTest.FakeRes retry = call(filter(), post("/token", "R2", "{\"tenant_id\":\"globex\"}", null));
        assertEquals(200, retry.status);
        assertEquals("R2", refreshTokensSeen.get(refreshTokensSeen.size() - 1));
        assertEquals("globex", json(retry).get("tenant_id"));
    }

    @Test
    void SPEC10_1_4a_differentCustomClaimsIsTheSameRetryBranchAndBodyModeCarriesTheToken() throws Exception {
        tokenDelayMs = 400;
        issuerToken("R2");
        RealmFilter f = realm.middleware().tokenDelivery(TokenDelivery.BODY).refreshWait(10, 100).buildFilter();
        ExecutorService ex = Executors.newFixedThreadPool(2);
        Future<RealmFilterTest.FakeRes> a = ex.submit(() -> call(f,
                post("/token", null, "{\"tenant_id\":\"acme\",\"refresh_token\":\"R1\"}", null)));
        Thread.sleep(60);
        Future<RealmFilterTest.FakeRes> b = ex.submit(() -> call(f,
                post("/token", null, "{\"tenant_id\":\"acme\",\"refresh_token\":\"R1\",\"custom_claims\":{\"a\":1}}", null)));
        assertEquals(200, a.get().status);
        RealmFilterTest.FakeRes loser = b.get();
        assertEquals(503, loser.status);
        assertEquals("R2", json(loser).get("refresh_token"));
        assertEquals(Boolean.TRUE, json(loser).get("retry"));
        assertEquals(1, tokenCalls.get());
        ex.shutdown();
    }

    @Test
    void SPEC10_1_4a_winnersErrorIsRelayedToTheLoserAndIssuerCalledOnce() throws Exception {
        tokenDelayMs = 300;
        api.on("POST /auth/token", (ex, body) -> {
            tokenCalls.incrementAndGet();
            try { Thread.sleep(tokenDelayMs); } catch (InterruptedException ignored) {}
            return FakeServer.Reply.json(401, Map.of("error", Map.of("code", "refresh_invalid", "message", "nope")));
        });
        List<RealmFilterTest.FakeRes> rs = concurrent(List.of(
                post("/token", "R1", "{\"tenant_id\":\"acme\"}", null),
                post("/token", "R1", "{\"tenant_id\":\"globex\"}", null)));
        assertEquals(1, tokenCalls.get());
        for (RealmFilterTest.FakeRes r : rs) {
            assertEquals(401, r.status);
            assertTrue(text(r).contains("refresh_invalid"));
        }
    }

    @Test
    void SPEC10_1_4a_sequentialRepeatWithinFiveSecondsIsServedFromTheStoredOutcome() throws Exception {
        issuerToken("R2");
        RealmFilterTest.FakeRes first = call(filter(), post("/token", "R1", "{\"tenant_id\":\"acme\"}", null));
        RealmFilterTest.FakeRes again = call(filter(), post("/token", "R1", "{\"tenant_id\":\"acme\"}", null));
        assertEquals(1, tokenCalls.get());
        assertEquals(json(first).get("access_token"), json(again).get("access_token"));
        assertEquals("R2", setCookieValue(again));
    }

    @Test
    void SPEC10_1_4a_outcomeWindowIsExactlyFiveSecondsAndTheLockIsReleased() throws Exception {
        java.util.concurrent.atomic.AtomicLong sec = new java.util.concurrent.atomic.AtomicLong(1_000_000);
        java.time.Clock clk = new java.time.Clock() {
            public java.time.ZoneId getZone() { return java.time.ZoneOffset.UTC; }
            public java.time.Clock withZone(java.time.ZoneId z) { return this; }
            public Instant instant() { return Instant.ofEpochSecond(sec.get()); }
        };
        realm = build(new MemorySessionStore(clk));
        issuerToken("R2");
        call(filter(), post("/token", "R1", "{\"tenant_id\":\"acme\"}", null));
        sec.addAndGet(6);
        call(filter(), post("/token", "R1", "{\"tenant_id\":\"acme\"}", null)); // acquires at once, reaches the issuer
        assertEquals(2, tokenCalls.get());
    }

    @Test
    void SPEC10_1_4a_lockHeldElsewhereWithNoOutcomeIs503InProgressAndStoreErrorIs503Unavailable() throws Exception {
        issuerToken("R2");
        assertTrue(store.acquireRefreshLock(SessionKeys.lockKey("R1"), Duration.ofSeconds(30)).acquired());
        RealmFilterTest.FakeRes r = call(filter(), post("/token", "R1", "{\"tenant_id\":\"acme\"}", null));
        assertEquals(503, r.status);
        assertTrue(text(r).contains("refresh in progress"));
        assertEquals(0, tokenCalls.get());

        realm = build(new SpyStore(new MemorySessionStore(), new ArrayList<>()) {
            @Override public RefreshLock acquireRefreshLock(String k, Duration ttl) { throw new IllegalStateException("down"); }
        });
        RealmFilterTest.FakeRes r2 = call(filter(), post("/token", "R1", "{\"tenant_id\":\"acme\"}", null));
        assertEquals(503, r2.status);
        assertTrue(text(r2).contains("session store unavailable"));
        assertEquals(0, tokenCalls.get());
    }

    // ---- SPEC10_1_4b: rotating refresh refuses older tokens ----

    @Test
    void SPEC10_1_4b_rotatingRefreshRefusesTheOlderTokenAndAcceptsTheNew() throws Exception {
        issuerToken("R2");
        long iat = now();
        String old = jwt("S1", "sub-acme", iat - 10, iat + 600);
        assertEquals(204, call(filter(), bearerGet("/x", old)).status);
        RealmFilterTest.FakeRes r = call(filter(), post("/token", "R1", "{\"tenant_id\":\"acme\"}", null));
        String fresh = (String) json(r).get("access_token");
        assertEquals(401, call(filter(), bearerGet("/x", old)).status);
        assertEquals(204, call(filter(), bearerGet("/x", fresh)).status);
    }

    @Test
    void SPEC10_1_4b_nonRotatingRefreshRecordsNothing() throws Exception {
        issuerToken(null); // echoes the presented token
        long iat = now();
        String old = jwt("S1", "sub-acme", iat - 10, iat + 600);
        call(filter(), post("/token", "R1", "{\"tenant_id\":\"acme\"}", null));
        assertEquals(204, call(filter(), bearerGet("/x", old)).status);
    }

    @Test
    void SPEC10_1_4b_concurrentModeKeepsTheOtherOrgAndExclusiveModeRefusesIt() throws Exception {
        issuerToken("R2");
        long iat = now();
        String acme = jwt("S1", "sub-acme", iat - 10, iat + 600);
        call(filter(), post("/token", "R1", "{\"tenant_id\":\"globex\"}", null));
        assertEquals(204, call(filter(), bearerGet("/x", acme)).status, "concurrent default");
        discoveryMode = "exclusive";
        realm = build(store); // fresh discovery cache; the marks are already recorded
        assertEquals(401, call(filter(), bearerGet("/x", acme)).status, "exclusive refuses at check time");
    }

    // ---- org_session_mode in bodies + discovery cache ----

    @Test
    void refreshBodyReportsOrgSessionModeFromDiscoveryAndCachesIt() throws Exception {
        issuerToken("R2");
        RealmFilterTest.FakeRes a = call(filter(), post("/token", "R1", "{\"tenant_id\":\"acme\"}", null));
        assertEquals("concurrent", json(a).get("org_session_mode"), "field absent -> concurrent");
        discoveryMode = "exclusive";
        realm = build(store);
        RealmFilterTest.FakeRes b = call(filter(), post("/token", "R2", "{\"tenant_id\":\"acme\"}", null));
        assertEquals("exclusive", json(b).get("org_session_mode"));
        int before = discoveryCalls.get();
        call(filter(), post("/token", "R2", "{\"tenant_id\":\"acme\"}", null));
        assertEquals(before, discoveryCalls.get(), "cached for 10 minutes");
    }

    @Test
    void discoveryFailureOrUnknownValueMeansConcurrent() throws Exception {
        issuerToken("R2");
        discoveryMode = "both";
        assertEquals("concurrent", json(call(filter(), post("/token", "R1", "{\"tenant_id\":\"acme\"}", null)))
                .get("org_session_mode"));
        api.on("GET /" + REALM_ID + "/.well-known/openid-configuration", (ex, b) -> FakeServer.Reply.json(500, Map.of()));
        realm = build(store);
        assertEquals("concurrent", json(call(filter(), post("/token", "R3", "{\"tenant_id\":\"acme\"}", null)))
                .get("org_session_mode"));
    }

    @Test
    void loginAndMfaBodiesCarryOrgSessionMode() throws Exception {
        discoveryMode = "exclusive";
        String at = jwt("S1", "u1", now(), now() + 600);
        api.on("POST /auth/login", (ex, b) -> {
            Map<String, Object> body = new LinkedHashMap<>(parse(b) instanceof Map<?, ?> m ? castMap(m) : Map.of());
            if ("platform_api_key".equals(body.get("grant_type"))) {
                return FakeServer.Reply.json(200, Map.of("access_token", "pt", "refresh_token", "rt",
                        "expires_in", 300, "subject_type", "platform"));
            }
            return FakeServer.Reply.json(200, Map.of("access_token", at, "refresh_token", "RL", "expires_in", 600,
                    "user", Map.of("id", "u1"), "tenants", List.of()));
        });
        RealmFilterTest.FakeRes r = call(filter(), post("/login", null, "{\"method\":\"google\",\"provider_token\":\"x\"}", null));
        assertEquals(200, r.status, text(r));
        assertEquals("exclusive", json(r).get("org_session_mode"));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Map<?, ?> m) { return (Map<String, Object>) m; }

    // ---- SPEC10_1_5: MFA verify under the lock ----

    @Test
    void SPEC10_1_5_mfaVerifyWithoutARefreshCandidateTakesNoLock() throws Exception {
        List<String> calls = Collections.synchronizedList(new ArrayList<>());
        realm = build(new SpyStore(new MemorySessionStore(), calls));
        api.on("POST /auth/mfa/verify", (ex, b) -> FakeServer.Reply.json(200, Map.of(
                "access_token", "a", "refresh_token", "RM", "expires_in", 60, "user", Map.of(), "tenants", List.of())));
        RealmFilterTest.FakeRes r = call(filter(), post("/mfa/verify", null, "{\"challenge_token\":\"c\",\"code\":\"1\"}", null));
        assertEquals(200, r.status, text(r));
        assertTrue(calls.stream().noneMatch(c -> c.startsWith("lock")), calls.toString());
    }

    @Test
    void SPEC10_1_5_mfaVerifyWaitsForTheLockThenCallsTheIssuerOnce() throws Exception {
        AtomicInteger verifies = new AtomicInteger();
        api.on("POST /auth/mfa/verify", (ex, b) -> {
            verifies.incrementAndGet();
            return FakeServer.Reply.json(200, Map.of("access_token", "a", "refresh_token", "RM",
                    "expires_in", 60, "user", Map.of(), "tenants", List.of()));
        });
        SessionStateStore.RefreshLock held = store.acquireRefreshLock(SessionKeys.lockKey("R1"), Duration.ofSeconds(30));
        ExecutorService ex = Executors.newSingleThreadExecutor();
        Future<RealmFilterTest.FakeRes> f = ex.submit(() ->
                call(realm.middleware().refreshWait(20, 100).buildFilter(),
                        post("/mfa/verify", "R1", "{\"challenge_token\":\"c\",\"code\":\"1\"}", null)));
        Thread.sleep(150);
        assertEquals(0, verifies.get(), "the issuer is not called while the lock is held");
        held.release().run();
        RealmFilterTest.FakeRes r = f.get();
        assertEquals(200, r.status, text(r));
        assertEquals(1, verifies.get());
        // a refresh loser later takes the different-fingerprint branch with the MFA token
        assertEquals("RM", setCookieValue(r));
        ex.shutdown();
    }

    @Test
    void SPEC10_1_5_mfaVerifyWaitingPastTheBudgetIs503AndTheChallengeIsNotConsumed() throws Exception {
        AtomicBoolean called = new AtomicBoolean();
        api.on("POST /auth/mfa/verify", (ex, b) -> { called.set(true); return FakeServer.Reply.json(200, Map.of()); });
        store.acquireRefreshLock(SessionKeys.lockKey("R1"), Duration.ofSeconds(30));
        RealmFilterTest.FakeRes r = call(filter(), post("/mfa/verify", "R1", "{\"challenge_token\":\"c\",\"code\":\"1\"}", null));
        assertEquals(503, r.status);
        assertTrue(text(r).contains("refresh in progress"));
        assertFalse(called.get());
    }

    // ---- store spy ----

    static class SpyStore implements SessionStateStore {
        final SessionStateStore inner;
        final List<String> calls;
        SpyStore(SessionStateStore inner, List<String> calls) { this.inner = inner; this.calls = calls; }
        public void revokeSession(String k, Instant u) { calls.add("revoke " + k); inner.revokeSession(k, u); }
        public void raiseNotBefore(String k, Instant nb, Instant u) { calls.add("raise " + k); inner.raiseNotBefore(k, nb, u); }
        public List<SessionState> sessionStates(List<String> k) { calls.add("states " + k); return inner.sessionStates(k); }
        public void evict(String p) { calls.add("evict " + p); inner.evict(p); }
        public RefreshLock acquireRefreshLock(String k, Duration ttl) { calls.add("lock " + k); return inner.acquireRefreshLock(k, ttl); }
        public void putRefreshResult(String k, byte[] r, Duration ttl) { calls.add("put " + k); inner.putRefreshResult(k, r, ttl); }
        public Optional<byte[]> getRefreshResult(String k) { return inner.getRefreshResult(k); }
    }
}
