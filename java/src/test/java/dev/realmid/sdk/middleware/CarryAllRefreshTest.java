package dev.realmid.sdk.middleware;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.auth.IdentityResolvedHandler;
import dev.realmid.sdk.auth.ProductRolesHandler;
import dev.realmid.sdk.auth.ScopesHandler;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * SPEC4_2_carry_all rules 1 and 2 (java, critic rows 1, 2, 9): every failure AFTER the first mint
 * rotated the refresh token carries the rotated session, and on the refresh route answers 503
 * (the issuer's own non-401 status and code relayed), never 401, with the rotated cookie set.
 */
class CarryAllRefreshTest {

    private FakeServer fs;
    private AtomicInteger mintCount;
    /** Status the SECOND mint answers; 0 = succeed. */
    private volatile int secondMintStatus;
    private volatile String secondMintCode = "refresh_invalid";

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        mintCount = new AtomicInteger();
        secondMintStatus = 0;
        fs.onJson("POST /auth/login", (body, rec) -> FakeServer.Reply.json(200, Map.of(
                "access_token", "pt-12345", "refresh_token", "rt",
                "expires_in", 300, "subject_type", "platform")));
        fs.onJson("POST /auth/token", (body, rec) -> {
            if (!body.containsKey("refresh_token")) {
                return FakeServer.Reply.json(200, Map.of("access_token", "pt-12345", "refresh_token", "rt",
                        "expires_in", 300, "subject_type", "platform"));
            }
            int n = mintCount.incrementAndGet();
            if (n >= 2 && secondMintStatus != 0) {
                return FakeServer.Reply.json(secondMintStatus,
                        Map.of("error", Map.of("code", secondMintCode, "message", "refused")));
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("access_token", jwtWithSub("u1"));
            out.put("refresh_token", "rtok" + n);
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

    private Realm.Builder base() {
        return Realm.builder().sessionStore(new dev.realmid.sdk.session.MemorySessionStore())
                .realmId("01HREALM").apiKey("rk_live_test").baseUrl(fs.baseUrl).audience("acme.test");
    }

    private RealmFilterTest.FakeRes refresh(Realm realm) throws Exception {
        RealmFilter f = realm.middleware().buildFilter();
        RealmFilterTest.FakeReq req = new RealmFilterTest.FakeReq("POST", "/token");
        req.headers.put("Cookie", List.of("realmid_refresh=rtok0"));
        req.body = "{\"tenant_id\":\"t1\"}".getBytes(StandardCharsets.UTF_8);
        RealmFilterTest.FakeRes res = new RealmFilterTest.FakeRes();
        f.doFilter(req, res, (rq, rs) -> { throw new AssertionError("chain must not run"); });
        return res;
    }

    /** 503 server_error, the first mint's rotated token delivered as the cookie, never a 401. */
    private void assertCarried503(RealmFilterTest.FakeRes res) {
        assertEquals(503, res.status, new String(res.bytes(), StandardCharsets.UTF_8));
        List<String> cookies = res.headers.get("Set-Cookie");
        assertNotNull(cookies, "the rotated refresh token must be handed to the browser");
        assertTrue(cookies.stream().anyMatch(c -> c.contains("realmid_refresh=rtok1")), cookies.toString());
        assertTrue(new String(res.bytes(), StandardCharsets.UTF_8).contains("server_error"));
        // SPEC.md:1447-1449: the carried 503 body says retry: true.
        assertTrue(new String(res.bytes(), StandardCharsets.UTF_8).matches("(?s).*\"retry\"\\s*:\\s*true.*"),
                new String(res.bytes(), StandardCharsets.UTF_8));
    }

    /** SPEC.md:1458 (final parity review finding 5): a carried escort_suspended keeps the 503. */
    @Test
    void SPEC4_2_carry_all_secondEscortSuspendedAnswers503() throws Exception {
        secondMintStatus = 403;
        secondMintCode = "escort_suspended";
        ProductRolesHandler h = (t, u) -> List.of("dispatch");
        RealmFilterTest.FakeRes res = refresh(base().productRoles(h).build());
        assertEquals(503, res.status, new String(res.bytes(), StandardCharsets.UTF_8));
        assertTrue(res.headers.get("Set-Cookie").stream().anyMatch(c -> c.contains("realmid_refresh=rtok1")));
    }

    @Test
    void SPEC4_2_carry_all_hookRefusalCarriesAndAnswers503() throws Exception {
        IdentityResolvedHandler hook = ev -> { throw new IllegalStateException("org refused"); };
        assertCarried503(refresh(base().onIdentityResolved(hook).build()));
    }

    @Test
    void SPEC4_2_carry_all_productRolesFailureCarriesAndAnswers503() throws Exception {
        ProductRolesHandler h = (t, u) -> { throw new IllegalStateException("store down"); };
        assertCarried503(refresh(base().productRoles(h).build()));
    }

    @Test
    void SPEC4_2_carry_all_scopesFailureCarriesAndAnswers503() throws Exception {
        ScopesHandler h = (t, u) -> { throw new IllegalStateException("store down"); };
        assertCarried503(refresh(base().scopes(h).build()));
    }

    @Test
    void SPEC4_2_carry_all_second401MintCarriesAndAnswers503() throws Exception {
        secondMintStatus = 401;
        ProductRolesHandler h = (t, u) -> List.of("dispatch");
        assertCarried503(refresh(base().productRoles(h).build()));
    }

    @Test
    void SPEC4_2_carry_all_second403RelaysItsOwnStatusAndCarries() throws Exception {
        secondMintStatus = 403;
        secondMintCode = "user_suspended";
        ProductRolesHandler h = (t, u) -> List.of("dispatch");
        RealmFilterTest.FakeRes res = refresh(base().productRoles(h).build());
        assertEquals(403, res.status, new String(res.bytes(), StandardCharsets.UTF_8));
        assertTrue(new String(res.bytes(), StandardCharsets.UTF_8).contains("user_suspended"));
        assertTrue(res.headers.get("Set-Cookie").stream().anyMatch(c -> c.contains("realmid_refresh=rtok1")));
    }

    @Test
    void SPEC4_2_carry_all_carrierStaysTokenFree() throws Exception {
        IdentityResolvedHandler hook = ev -> { throw new IllegalStateException("org refused"); };
        RealmFilterTest.FakeRes res = refresh(base().onIdentityResolved(hook).build());
        assertFalse(new String(res.bytes(), StandardCharsets.UTF_8).contains("rtok1"),
                "the rotated token travels in the cookie, not the JSON body, in cookie mode");
    }
}
