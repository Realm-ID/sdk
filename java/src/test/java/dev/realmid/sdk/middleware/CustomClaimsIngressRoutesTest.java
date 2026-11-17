package dev.realmid.sdk.middleware;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Audit e-01 (owner ruling 3), sdk/SPEC.md SPEC10_1_4_no_client_claims: the login (step 2),
 * MFA verify (step 5) and recovery (step 5a) routes answer 400 custom_claims_not_accepted for a
 * body carrying custom_claims / customClaims (any value), before the issuer is called.
 */
class CustomClaimsIngressRoutesTest {

    private FakeServer fs;
    private AtomicInteger issuerCalls;

    @BeforeEach
    void setUp() throws Exception {
        fs = new FakeServer();
        issuerCalls = new AtomicInteger();
        for (String route : new String[]{"POST /auth/login", "POST /auth/mfa/verify", "POST /auth/mfa/recovery",
                "POST /auth/token"}) {
            fs.onJson(route, (body, rec) -> {
                issuerCalls.incrementAndGet();
                return FakeServer.Reply.json(500, Map.of("error", Map.of("code", "server_error")));
            });
        }
    }

    @AfterEach
    void tearDown() { fs.close(); }

    private RealmFilterTest.FakeRes post(String path, String body) throws Exception {
        Realm realm = Realm.builder().sessionStore(new dev.realmid.sdk.session.MemorySessionStore())
                .realmId("01HREALM").apiKey("rk_live_test").baseUrl(fs.baseUrl).audience("acme.test").build();
        RealmFilter f = realm.middleware().recoveryPath("/mfa/recovery").originEnforcement(OriginEnforcement.OFF).buildFilter();
        RealmFilterTest.FakeReq req = new RealmFilterTest.FakeReq("POST", path);
        req.body = body.getBytes(StandardCharsets.UTF_8);
        RealmFilterTest.FakeRes res = new RealmFilterTest.FakeRes();
        f.doFilter(req, res, (rq, rs) -> { throw new AssertionError("chain must not run"); });
        return res;
    }

    @Test
    void SPEC10_1_4_loginVerifyAndRecoveryRefuseBrowserCustomClaims() throws Exception {
        String[][] routes = {
                {"/login", "{\"method\":\"firebase\",\"provider_token\":\"p\",\"%K\":%V}"},
                {"/mfa/verify", "{\"challenge_token\":\"c\",\"code\":\"1\",\"%K\":%V}"},
                {"/mfa/recovery", "{\"challenge_token\":\"c\",\"code\":\"r\",\"%K\":%V}"},
        };
        int ran = 0;
        for (String[] r : routes) {
            for (String key : new String[]{"custom_claims", "customClaims"}) {
                for (String val : new String[]{"{\"outlet_ids\":[\"o1\"]}", "null", "{}", "\"x\"", "5"}) {
                    RealmFilterTest.FakeRes res = post(r[0], r[1].replace("%K", key).replace("%V", val));
                    String text = new String(res.bytes(), StandardCharsets.UTF_8);
                    assertEquals(400, res.status, r[0] + " " + key + "=" + val + " " + text);
                    assertTrue(text.contains("\"custom_claims_not_accepted\""), text);
                    ran++;
                }
            }
        }
        assertEquals(30, ran);
        assertEquals(0, issuerCalls.get(), "the issuer must not be called");
    }
}
