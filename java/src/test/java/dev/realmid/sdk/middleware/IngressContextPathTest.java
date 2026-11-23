package dev.realmid.sdk.middleware;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

/**
 * SPEC11_4_1_ingress: the ingress routes compare on the context-relative servlet path only.
 * Context path "/app": request POST /app/auth/x has servlet path /auth/x.
 */
class IngressContextPathTest {

    private FakeServer fs;

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
    }

    @AfterEach
    void tearDown() { fs.close(); }

    /** Drives one POST with context path /app; returns the status, 401 meaning "fell to the bearer check". */
    private int drive(String route, String configured, String requestUri, String servletPath) throws Exception {
        Realm realm = Realm.builder().sessionStore(new dev.realmid.sdk.session.MemorySessionStore())
                .realmId("01HREALM").apiKey("rk_live_test").baseUrl(fs.baseUrl).audience("acme.test").build();
        MiddlewareConfig.Builder mb = realm.middleware();
        switch (route) {
            case "loginPath" -> mb.loginPath(configured);
            case "refreshPath" -> mb.refreshPath(configured);
            case "logoutPath" -> mb.logoutPath(configured);
            case "mfaVerifyPath" -> mb.mfaVerifyPath(configured);
            case "recoveryPath" -> mb.recoveryPath(configured);
            default -> throw new IllegalArgumentException(route);
        }
        RealmFilter f = mb.buildFilter();
        RealmFilterTest.FakeReq req = new RealmFilterTest.FakeReq("POST", requestUri, servletPath, null);
        req.body = "{}".getBytes(StandardCharsets.UTF_8);
        RealmFilterTest.FakeRes res = new RealmFilterTest.FakeRes();
        f.doFilter(req, res, (rq, rs) -> { });
        // A routed ingress handler may answer 401 itself (no cookie); only the bearer fall-through
        // says "missing bearer token", so that marks "the route did not match".
        String body = new String(res.bytes(), StandardCharsets.UTF_8);
        return body.contains("missing bearer token") ? 401 : (res.status == 401 ? 499 : res.status);
    }

    private static final Map<String, String> ROUTES = Map.of(
            "loginPath", "/auth/login", "refreshPath", "/auth/token", "logoutPath", "/auth/logout",
            "mfaVerifyPath", "/auth/mfa", "recoveryPath", "/auth/recover");

    @Test
    void SPEC11_4_1_ingress_contextRelativeFormMatches() throws Exception {
        for (var e : ROUTES.entrySet()) {
            int s = drive(e.getKey(), e.getValue(), "/app" + e.getValue(), e.getValue());
            assertNotEquals(401, s, e.getKey() + " context-relative form must route, got " + s);
        }
    }

    @Test
    void SPEC11_4_1_ingress_aFullRequestUriConfigDoesNotMatch() throws Exception {
        for (var e : ROUTES.entrySet()) {
            String full = "/app" + e.getValue();
            assertEquals(401, drive(e.getKey(), full, full, e.getValue()),
                    e.getKey() + " configured with the context prefix must not route");
        }
    }

    @Test
    void SPEC11_4_1_ingress_aWrongPathStillFallsToBearerCheck() throws Exception {
        assertEquals(401, drive("loginPath", "/other/login", "/app/auth/login", "/auth/login"));
    }

    @Test
    void SPEC11_4_1_ingress_fullUriCompatDoesNotRelaxInvalidPath() throws Exception {
        // a non-canonical raw path is refused before any route, in either form
        assertEquals(400, drive("loginPath", "/app/auth/%2Flogin", "/app/auth/%2Flogin", "/auth/login"));
    }
}
