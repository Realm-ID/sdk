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
import java.util.Collections;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/** SPEC 10.1 step 3: the logout route passes a boolean-true {@code all} to the issuer for every candidate. */
class LogoutAllRouteTest {

    private static final String REALM_ID = "01HREALM";
    private static final ObjectMapper M = new ObjectMapper();

    private FakeServer api;
    private Realm realm;
    private final List<String> logoutBodies = Collections.synchronizedList(new ArrayList<>());

    @BeforeEach
    void setUp() throws Exception {
        api = new FakeServer();
        api.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("access_token", "pt", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform")));
        api.on("POST /auth/logout", (ex, body) -> {
            logoutBodies.add(new String(body, StandardCharsets.UTF_8));
            return FakeServer.Reply.json(200, Map.of("status", "ok"));
        });
        realm = Realm.builder().sessionStore(new MemorySessionStore()).realmId(REALM_ID).apiKey("rk")
                .baseUrl(api.baseUrl).audience("acme.test").build();
    }

    @AfterEach
    void tearDown() { api.close(); }

    private void logout(TokenDelivery d, String cookie, String json) throws Exception {
        RealmFilter f = realm.middleware().tokenDelivery(d).buildFilter();
        RealmFilterTest.FakeReq r = new RealmFilterTest.FakeReq("POST", "/logout");
        if (cookie != null) r.headers.put("Cookie", new ArrayList<>(List.of("realmid_refresh=" + cookie)));
        r.body = json.getBytes(StandardCharsets.UTF_8);
        RealmFilterTest.FakeRes res = new RealmFilterTest.FakeRes();
        f.doFilter(r, res, (rq, rs) -> { throw new AssertionError("chain should not run"); });
        assertEquals(200, res.status);
    }

    @Test
    void cookieModeSendsAllTrue() throws Exception {
        logout(TokenDelivery.COOKIE, "rt1", "{\"all\":true}");
        assertEquals(1, logoutBodies.size());
        assertEquals(Boolean.TRUE, M.readValue(logoutBodies.get(0), Map.class).get("all"));
    }

    @Test
    void bodyModeSendsAllTrue() throws Exception {
        logout(TokenDelivery.BODY, null, "{\"refresh_token\":\"rt1\",\"all\":true}");
        assertEquals(Boolean.TRUE, M.readValue(logoutBodies.get(0), Map.class).get("all"));
    }

    @Test
    void anyOtherValueOfAllIsNotSet() throws Exception {
        for (String v : new String[]{"false", "\"true\"", "1", "null"}) {
            logoutBodies.clear();
            logout(TokenDelivery.COOKIE, "rt1", "{\"all\":" + v + "}");
            assertFalse(M.readValue(logoutBodies.get(0), Map.class).containsKey("all"), v);
        }
        logoutBodies.clear();
        logout(TokenDelivery.COOKIE, "rt1", "{}");
        assertFalse(M.readValue(logoutBodies.get(0), Map.class).containsKey("all"));
    }
}
