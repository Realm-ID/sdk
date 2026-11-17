package dev.realmid.sdk.middleware;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.session.MemorySessionStore;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/** SPEC 10.5 SPEC10_5_origin_all: the Origin guard on the login, refresh, MFA-verify and recovery routes. */
class OriginEnforcementTest {

    private static final String REALM_ID = "01HREALM";
    private static final ObjectMapper M = new ObjectMapper();

    private FakeServer api;
    private String policy = "required";
    private boolean discoveryDown;
    private boolean allowlistDown;
    private int issuerCalls;

    @BeforeEach
    void setUp() throws Exception {
        api = new FakeServer();
        api.on("POST /auth/login", (ex, body) -> { issuerCalls++; return FakeServer.Reply.json(200,
                Map.of("access_token", "pt", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform")); });
        api.on("GET /platforms/mine", (ex, body) -> {
            if (discoveryDown) return FakeServer.Reply.json(500, Map.of("error", Map.of("code", "server_error", "message", "x")));
            Map<String, Object> p = new LinkedHashMap<>();
            p.put("id", REALM_ID);
            p.put("audience", "acme.test");
            p.put("origin_enforcement", policy);
            return FakeServer.Reply.json(200, List.of(p));
        });
        api.on("GET /platforms/" + REALM_ID + "/origins", (ex, body) -> {
            if (allowlistDown) return FakeServer.Reply.json(500, Map.of("error", Map.of("code", "server_error", "message", "x")));
            Map<String, Object> page = new LinkedHashMap<>();
            page.put("items", List.of(Map.of("id", "o1", "domain", "app.acme.test")));
            page.put("next_cursor", null);
            return FakeServer.Reply.json(200, page);
        });
    }

    @AfterEach
    void tearDown() { api.close(); }

    private MiddlewareConfig.Builder builder() {
        Realm realm = Realm.builder().sessionStore(new MemorySessionStore()).realmId(REALM_ID).apiKey("rk")
                .baseUrl(api.baseUrl).audience("acme.test").build();
        return realm.middleware().recoveryPath("/mfa/recovery");
    }

    private RealmFilterTest.FakeRes post(RealmFilter f, String path, String origin) throws Exception {
        RealmFilterTest.FakeReq r = new RealmFilterTest.FakeReq("POST", path);
        if (origin != null) r.headers.put("Origin", new ArrayList<>(List.of(origin)));
        r.headers.put("Cookie", new ArrayList<>(List.of("realmid_refresh=rt0")));
        r.body = "{}".getBytes(StandardCharsets.UTF_8);
        RealmFilterTest.FakeRes res = new RealmFilterTest.FakeRes();
        f.doFilter(r, res, (rq, rs) -> ((jakarta.servlet.http.HttpServletResponse) rs).setStatus(204));
        return res;
    }

    private static String code(RealmFilterTest.FakeRes res) throws Exception {
        if (res.bytes().length == 0) return "";
        Object err = M.readValue(res.bytes(), Map.class).get("error");
        return err instanceof Map<?, ?> m ? String.valueOf(m.get("code")) : "";
    }

    @Test
    void foreignOriginIsRefusedOnEveryGuardedRoute() throws Exception {
        RealmFilter f = builder().buildFilter();
        for (String path : new String[]{"/login", "/token", "/mfa/verify", "/mfa/recovery"}) {
            RealmFilterTest.FakeRes res = post(f, path, "https://evil.test");
            assertEquals(403, res.status, path);
            assertEquals("realm_origin_mismatch", code(res), path);
        }
    }

    @Test
    void absentOrBlankOriginIsMissingOrigin() throws Exception {
        RealmFilter f = builder().buildFilter();
        assertEquals("missing_origin", code(post(f, "/login", null)));
        assertEquals("missing_origin", code(post(f, "/login", "  ")));
        assertEquals(403, post(f, "/token", null).status);
    }

    @Test
    void listedOriginIsDispatched() throws Exception {
        RealmFilter f = builder().buildFilter();
        String c = code(post(f, "/login", "https://app.acme.test"));
        assertNotEquals("realm_origin_mismatch", c);
        assertNotEquals("missing_origin", c);
    }

    @Test
    void unreadableAllowlistIs502() throws Exception {
        allowlistDown = true;
        RealmFilterTest.FakeRes res = post(builder().buildFilter(), "/login", "https://app.acme.test");
        assertEquals(502, res.status);
        assertEquals("server_error", code(res));
    }

    @Test
    void logoutIsNotGuarded() throws Exception {
        RealmFilterTest.FakeRes res = post(builder().buildFilter(), "/logout", "https://evil.test");
        assertEquals(200, res.status);
    }

    @Test
    void modes() throws Exception {
        assertNotEquals("realm_origin_mismatch",
                code(post(builder().originEnforcement(OriginEnforcement.OFF).buildFilter(), "/login", "https://evil.test")));
        policy = "optional";
        assertNotEquals("realm_origin_mismatch", code(post(builder().buildFilter(), "/login", "https://evil.test")));
        assertEquals("realm_origin_mismatch",
                code(post(builder().originEnforcement(OriginEnforcement.ON).buildFilter(), "/login", "https://evil.test")));
    }

    @Test
    void autoFailsOpenWhenPolicyCannotBeRead() throws Exception {
        discoveryDown = true;
        assertNotEquals("realm_origin_mismatch", code(post(builder().buildFilter(), "/login", "https://evil.test")));
    }
}
