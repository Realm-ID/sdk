package dev.realmid.sdk.middleware;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.auth.LogoutRequest;
import dev.realmid.sdk.session.MemorySessionStore;
import dev.realmid.sdk.verifier.VerifierTestKeys;
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

import static org.junit.jupiter.api.Assertions.*;

/**
 * Critic wave 4 (Java-tagged): H2 reload-path fingerprint, M1 lock TTL, M2 logout
 * no-cookie bearer fallback, M3 `all` on the logout request, L3 body-mode
 * camelCase refresh token on logout.
 */
class V063Wave4Test {
    private static final String REALM_ID = "01HREALM";
    private static final String AUDIENCE = "acme.test";
    private static final ObjectMapper M = new ObjectMapper();

    private FakeServer api;
    private VerifierTestKeys keys;
    private Realm realm;
    private final List<String> logoutBodies = Collections.synchronizedList(new ArrayList<>());
    private final List<Duration> lockTtls = Collections.synchronizedList(new ArrayList<>());
    private final List<Duration> putTtls = Collections.synchronizedList(new ArrayList<>());

    @BeforeEach
    void setUp() throws Exception {
        keys = new VerifierTestKeys();
        api = new FakeServer();
        api.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("access_token", "pt", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform")));
        api.on("GET /" + REALM_ID + "/.well-known/jwks.json", (ex, body) -> FakeServer.Reply.json(200, keys.jwks()));
        api.on("GET /" + REALM_ID + "/.well-known/openid-configuration",
                (ex, body) -> FakeServer.Reply.json(200, Map.of("issuer", "x")));
        api.on("POST /auth/logout", (ex, body) -> {
            logoutBodies.add(new String(body, StandardCharsets.UTF_8));
            return FakeServer.Reply.json(200, Map.of("status", "ok"));
        });
        api.on("POST /auth/token", (ex, body) -> {
            try {
                Map<?, ?> b = M.readValue(body, Map.class);
                long iat = Instant.now().getEpochSecond();
                String tenant = String.valueOf(b.get("tenant_id"));
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("access_token", jwt("S1", "sub-" + tenant, iat, iat + 600));
                out.put("refresh_token", "R2");
                out.put("expires_in", 600);
                out.put("tenant_id", tenant);
                out.put("role", "member");
                return FakeServer.Reply.json(200, out);
            } catch (Exception e) { throw new RuntimeException(e); }
        });
        realm = Realm.builder().sessionStore(new RecordingStore()).realmId(REALM_ID).apiKey("rk")
                .baseUrl(api.baseUrl).audience(AUDIENCE).build();
    }

    @AfterEach
    void tearDown() { api.close(); }

    private class RecordingStore extends V063MiddlewareTest.SpyStore {
        RecordingStore() { super(new MemorySessionStore(), new ArrayList<>()); }
        @Override public RefreshLock acquireRefreshLock(String k, Duration ttl) {
            lockTtls.add(ttl);
            return super.acquireRefreshLock(k, ttl);
        }
        @Override public void putRefreshResult(String k, byte[] r, Duration ttl) {
            putTtls.add(ttl);
            super.putRefreshResult(k, r, ttl);
        }
    }

    private String jwt(String sid, String sub, long iat, long exp) throws Exception {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("iss", api.baseUrl + "/" + REALM_ID);
        c.put("sub", sub);
        c.put("aud", AUDIENCE);
        c.put("iat", iat);
        c.put("exp", exp);
        c.put("sid", sid);
        c.put("jti", "j-" + iat + sub);
        return keys.sign(c);
    }

    private long now() { return Instant.now().getEpochSecond(); }

    private RealmFilter filter(TokenDelivery d) {
        return realm.middleware().tokenDelivery(d).refreshWait(10, 100).buildFilter();
    }

    private RealmFilterTest.FakeRes call(RealmFilter f, RealmFilterTest.FakeReq req) throws Exception {
        RealmFilterTest.FakeRes res = new RealmFilterTest.FakeRes();
        f.doFilter(req, res, (rq, rs) -> ((jakarta.servlet.http.HttpServletResponse) rs).setStatus(204));
        return res;
    }

    private RealmFilterTest.FakeReq post(String path, String cookie, String json, String bearer) {
        RealmFilterTest.FakeReq r = new RealmFilterTest.FakeReq("POST", path);
        if (cookie != null) r.headers.put("Cookie", new ArrayList<>(List.of("realmid_refresh=" + cookie)));
        if (bearer != null) r.headers.put("Authorization", new ArrayList<>(List.of("Bearer " + bearer)));
        r.body = json.getBytes(StandardCharsets.UTF_8);
        return r;
    }

    private RealmFilterTest.FakeReq bearerGet(String path, String token) {
        RealmFilterTest.FakeReq r = new RealmFilterTest.FakeReq("GET", path);
        r.headers.put("Authorization", new ArrayList<>(List.of("Bearer " + token)));
        return r;
    }

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

    // ---- H2: the winner-RELOAD path checks the fingerprint ----

    @Test
    void H2_sequentialRefreshForAnotherTenantWithinTheWindowGets503RetryNotTheFirstTenantsToken() throws Exception {
        RealmFilterTest.FakeRes a = call(filter(TokenDelivery.COOKIE), post("/token", "R1", "{\"tenant_id\":\"acme\"}", null));
        assertEquals(200, a.status);
        RealmFilterTest.FakeRes b = call(filter(TokenDelivery.COOKIE), post("/token", "R1", "{\"tenant_id\":\"globex\"}", null));
        assertEquals(503, b.status);
        assertEquals(Boolean.TRUE, json(b).get("retry"));
        assertEquals("R2", setCookieValue(b));
        assertNull(json(b).get("access_token"), "tenant A's access token must not reach a tenant-B request");
    }

    // ---- M1: lock TTL = bound + 5 s ----

    @Test
    void M1_lockTtlIsFifteenSecondsAndTheOutcomeKeepsItsFiveSecondWindow() throws Exception {
        call(filter(TokenDelivery.COOKIE), post("/token", "R1", "{\"tenant_id\":\"acme\"}", null));
        assertEquals(List.of(Duration.ofSeconds(15)), lockTtls);
        assertEquals(List.of(Duration.ofSeconds(5)), putTtls);
    }

    // ---- M2: logout with no cookie falls back to the verified bearer ----

    @Test
    void M2_logoutWithNoRefreshCandidateRevokesTheVerifiedUnexpiredBearersSession() throws Exception {
        RealmFilterTest.FakeRes out = call(filter(TokenDelivery.COOKIE),
                post("/logout", null, "{}", jwt("S1", "u1", now(), now() + 600)));
        assertEquals(200, out.status);
        assertTrue(logoutBodies.isEmpty(), "no candidate, no issuer call");
        assertEquals(401, call(filter(TokenDelivery.COOKIE), bearerGet("/x", jwt("S1", "u1", now() + 1, now() + 601))).status);
        // an expired bearer with no cookie revokes nothing
        RealmFilterTest.FakeRes out2 = call(filter(TokenDelivery.COOKIE),
                post("/logout", null, "{}", jwt("S5", "u1", now() - 7200, now() - 3600)));
        assertEquals(200, out2.status);
        assertEquals(204, call(filter(TokenDelivery.COOKIE), bearerGet("/x", jwt("S5", "u1", now(), now() + 600))).status);
    }

    // ---- L3: body-mode logout accepts refreshToken too ----

    @Test
    void L3_bodyModeLogoutAcceptsCamelCaseRefreshToken() throws Exception {
        call(filter(TokenDelivery.BODY), post("/logout", null, "{\"refreshToken\":\"rt-camel\"}", null));
        assertEquals(1, logoutBodies.size());
        assertEquals("rt-camel", M.readValue(logoutBodies.get(0), Map.class).get("refresh_token"));
        logoutBodies.clear();
        call(filter(TokenDelivery.BODY), post("/logout", null, "{\"refresh_token\":\"rt-snake\",\"refreshToken\":\"x\"}", null));
        assertEquals("rt-snake", M.readValue(logoutBodies.get(0), Map.class).get("refresh_token"));
    }

    // ---- M3 (owner ruling): `all` is SDK surface ----

    @Test
    void M3_logoutAllIsSentAndEveryRevokedSidIsRevoked() throws Exception {
        api.on("POST /auth/logout", (ex, body) -> {
            logoutBodies.add(new String(body, StandardCharsets.UTF_8));
            return FakeServer.Reply.json(200, Map.of("status", "ok", "sid", "S1", "revoked_sids", List.of("S1", "S2")));
        });
        realm.auth().logout(new LogoutRequest("rt1", null, null, true));
        Map<?, ?> sent = M.readValue(logoutBodies.get(0), Map.class);
        assertEquals(Boolean.TRUE, sent.get("all"));
        assertEquals("rt1", sent.get("refresh_token"));
        for (String sid : new String[]{"S1", "S2"}) {
            assertEquals(401, call(filter(TokenDelivery.COOKIE), bearerGet("/x", jwt(sid, "u1", now(), now() + 600))).status, sid);
        }
    }

    @Test
    void M3_logoutWithoutAllOmitsTheKey() throws Exception {
        realm.auth().logout(LogoutRequest.of("rt1"));
        assertFalse(M.readValue(logoutBodies.get(0), Map.class).containsKey("all"));
    }
}
