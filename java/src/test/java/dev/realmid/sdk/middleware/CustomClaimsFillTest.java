package dev.realmid.sdk.middleware;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import dev.realmid.sdk.auth.CustomClaimKeyException;
import dev.realmid.sdk.auth.CustomClaimsException;
import dev.realmid.sdk.auth.CustomClaimsHandler;
import dev.realmid.sdk.auth.RefreshHandedOverException;
import dev.realmid.sdk.auth.TokenRequest;
import dev.realmid.sdk.auth.TokenResponse;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * sdk/SPEC.md SPEC4_2_fill (a direct auth.token(req) that omits customClaims is filled from the
 * handler) and SPEC4_2_rotate_handover (a failure after the first mint carries the rotated
 * session; decision (c): an unreadable sub refuses with the handler error type and carries it).
 */
class CustomClaimsFillTest {

    private FakeServer fs;
    private final List<Map<String, Object>> mints = new ArrayList<>();
    private final AtomicInteger n = new AtomicInteger();
    private volatile int secondStatus = 200;
    private volatile String firstAccess;

    @BeforeEach
    void setUp() throws Exception {
        fs = new FakeServer();
        firstAccess = jwtWithSub("u-fill");
        fs.onJson("POST /auth/login", (body, rec) -> FakeServer.Reply.json(200, Map.of(
                "access_token", "pt-12345", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform")));
        fs.onJson("POST /auth/token", (body, rec) -> {
            mints.add(body);
            int k = n.incrementAndGet();
            if (k == 2 && secondStatus != 200) {
                return FakeServer.Reply.json(secondStatus, Map.of("error",
                        Map.of("code", "reserved_claim_key", "message", "key refused")));
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("access_token", k == 1 ? firstAccess : "A" + k);
            out.put("refresh_token", "R" + k);
            out.put("expires_in", 900);
            out.put("subject_type", "user");
            out.put("tenant_id", "t1");
            out.put("role", "member");
            return FakeServer.Reply.json(200, out);
        });
    }

    @AfterEach
    void tearDown() { fs.close(); }

    private static String jwtWithSub(String sub) {
        Base64.Encoder e = Base64.getUrlEncoder().withoutPadding();
        String h = e.encodeToString("{\"alg\":\"RS256\",\"kid\":\"kid-1\"}".getBytes(StandardCharsets.UTF_8));
        String p = e.encodeToString(("{\"sub\":\"" + sub + "\",\"tenant_id\":\"t1\"}").getBytes(StandardCharsets.UTF_8));
        return h + "." + p + ".c2ln";
    }

    private Realm realm(CustomClaimsHandler h) {
        return Realm.builder().sessionStore(new dev.realmid.sdk.session.MemorySessionStore())
                .realmId("01HREALM").apiKey("rk_live_test").baseUrl(fs.baseUrl).audience("acme.test")
                .customClaims(h).build();
    }

    @Test
    void SPEC4_2_fill_omittedCustomClaimsAreFilledFromTheHandlerOnTheRotatedToken() {
        List<String> args = new ArrayList<>();
        Realm realm = realm((t, u) -> { args.add(t + "/" + u); return Map.of("outlet_ids", List.of("o1")); });
        TokenResponse out = realm.auth().token(TokenRequest.of("R0", "t1"));
        assertEquals(List.of("t1/u-fill"), args);
        assertEquals(2, mints.size());
        assertEquals("R0", mints.get(0).get("refresh_token"));
        assertFalse(mints.get(0).containsKey("custom_claims"));
        assertEquals("R1", mints.get(1).get("refresh_token"), "the second mint presents the ROTATED token");
        assertEquals(Map.of("outlet_ids", List.of("o1")), mints.get(1).get("custom_claims"));
        assertEquals("R2", out.refreshToken());
    }

    @Test
    void SPEC4_2_fill_explicitClaimsAndExplicitEmptyAreSentAsGiven() {
        Realm realm = realm((t, u) -> { throw new AssertionError("handler must not run"); });
        realm.auth().token(new TokenRequest("R0", "t1", Map.of("a", 1), null, null, null, null));
        assertEquals(1, mints.size());
        assertEquals(Map.of("a", 1), mints.get(0).get("custom_claims"));
        mints.clear();
        realm.auth().token(new TokenRequest("R5", "t1", Map.of(), null, null, null, null));
        assertEquals(1, mints.size());
    }

    @Test
    void SPEC4_2_fill_noHandlerMintsOnce() {
        realm(null).auth().token(TokenRequest.of("R0", "t1"));
        assertEquals(1, mints.size());
    }

    @Test
    void SPEC4_2_rotate_handover_handlerFailureCarriesTheRotatedSession() {
        Realm realm = realm((t, u) -> { throw new IllegalStateException("store down"); });
        RefreshHandedOverException e = assertThrows(RefreshHandedOverException.class,
                () -> realm.auth().token(TokenRequest.of("R0", "t1")));
        assertInstanceOf(CustomClaimsException.class, e.getCause());
        assertEquals("R1", e.refreshToken());
        assertEquals(firstAccess, e.accessToken());
        assertFalse(e.getMessage().contains("R1") || e.toString().contains("R1"));
        assertEquals(1, mints.size(), "no second mint after the handler failed");
    }

    @Test
    void SPEC4_2_rotate_handover_keyCheckFailureCarriesTheRotatedSession() {
        Realm realm = realm((t, u) -> Map.of("sub", "x"));
        RefreshHandedOverException e = assertThrows(RefreshHandedOverException.class,
                () -> realm.auth().token(TokenRequest.of("R0", "t1")));
        assertInstanceOf(CustomClaimKeyException.class, e.getCause());
        assertEquals("R1", e.refreshToken());
    }

    @Test
    void SPEC4_2_rotate_handover_refusedSecondMintCarriesTheRotatedSession() {
        secondStatus = 400;
        Realm realm = realm((t, u) -> Map.of("outlet_ids", List.of("o1")));
        RefreshHandedOverException e = assertThrows(RefreshHandedOverException.class,
                () -> realm.auth().token(TokenRequest.of("R0", "t1")));
        assertInstanceOf(RealmException.class, e.getCause());
        assertEquals("R1", e.refreshToken());
        assertEquals(firstAccess, e.accessToken());
    }

    @Test
    void SPEC4_2_rotate_handover_unreadableSubRefusesWithHandlerErrorAndCarriesSession() {
        firstAccess = "opaque-access-token";
        Realm realm = realm((t, u) -> { throw new AssertionError("handler must not run without a subject"); });
        RefreshHandedOverException e = assertThrows(RefreshHandedOverException.class,
                () -> realm.auth().token(TokenRequest.of("R0", "t1")));
        assertInstanceOf(CustomClaimsException.class, e.getCause());
        assertEquals("R1", e.refreshToken());
        assertEquals("opaque-access-token", e.accessToken());
    }

    @Test
    void SPEC4_2_rotate_handover_tokenManagerAdoptsTheCarriedTokenBeforeFailing() {
        Realm realm = realm((t, u) -> { throw new IllegalStateException("store down"); });
        List<String> persisted = new ArrayList<>();
        dev.realmid.sdk.auth.TokenManager mgr = realm.auth().newTokenManager("R0",
                new dev.realmid.sdk.auth.TokenManagerOptions().tenantId("t1").refreshSink(persisted::add));
        assertThrows(RefreshHandedOverException.class, mgr::accessToken);
        assertEquals(List.of("R1"), persisted);
    }

    @Test
    void SPEC4_2_rotate_handover_middlewareRefreshHandsTheRotatedTokenToTheBrowser() throws Exception {
        Realm realm = realm((t, u) -> { throw new IllegalStateException("store down"); });
        RealmFilter f = realm.middleware().buildFilter();
        RealmFilterTest.FakeReq req = new RealmFilterTest.FakeReq("POST", "/token");
        req.headers.put("Cookie", List.of("realmid_refresh=R0"));
        req.body = "{\"tenant_id\":\"t1\"}".getBytes(StandardCharsets.UTF_8);
        RealmFilterTest.FakeRes res = new RealmFilterTest.FakeRes();
        f.doFilter(req, res, (a, b) -> { throw new AssertionError("chain must not run"); });
        assertEquals(503, res.status);
        List<String> cookies = res.headers.getOrDefault("Set-Cookie", List.of());
        assertTrue(cookies.stream().anyMatch(c -> c.startsWith("realmid_refresh=R1")), cookies.toString());
        assertNull(null);
    }

    @Test
    void SPEC4_2_rotate_handover_middlewareBodyModeCarriesTheTokenInTheBody() throws Exception {
        Realm realm = realm((t, u) -> { throw new IllegalStateException("store down"); });
        RealmFilter f = realm.middleware().tokenDelivery(TokenDelivery.BODY).buildFilter();
        RealmFilterTest.FakeReq req = new RealmFilterTest.FakeReq("POST", "/token");
        req.body = "{\"tenant_id\":\"t1\",\"refresh_token\":\"R0\"}".getBytes(StandardCharsets.UTF_8);
        RealmFilterTest.FakeRes res = new RealmFilterTest.FakeRes();
        f.doFilter(req, res, (a, b) -> { throw new AssertionError("chain must not run"); });
        assertEquals(503, res.status);
        assertTrue(new String(res.bytes(), StandardCharsets.UTF_8).contains("\"refresh_token\":\"R1\""),
                new String(res.bytes(), StandardCharsets.UTF_8));
    }
}
