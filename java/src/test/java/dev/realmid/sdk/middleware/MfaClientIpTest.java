package dev.realmid.sdk.middleware;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.auth.MFAVerifyRequest;
import dev.realmid.sdk.auth.RedeemRecoveryCodeRequest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Issuer middleware.go (c-01/c-02) puts POST /auth/mfa/verify and /auth/mfa/recovery on the per-IP
 * public-auth limiter, keyed on X-On-Behalf-Of-IP when a platform-bearer caller supplies it. SDK SPEC
 * 10.1 steps 5 / 5a: the middleware forwards the end user's IP on both calls, and the direct
 * AuthClient requests carry onBehalfOfIp like SendLoginCodeRequest does.
 */
class MfaClientIpTest {

    private FakeServer fs;

    @BeforeEach
    void setUp() throws Exception {
        fs = new FakeServer();
        fs.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("access_token", "pt", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform")));
        Map<String, Object> ok = Map.of("access_token", "a", "refresh_token", "RM", "expires_in", 60,
                "user", Map.of(), "tenants", List.of());
        fs.on("POST /auth/mfa/verify", (ex, body) -> FakeServer.Reply.json(200, ok));
        fs.on("POST /auth/mfa/recovery", (ex, body) -> FakeServer.Reply.json(200, ok));
    }

    @AfterEach
    void tearDown() { fs.close(); }

    private Realm realm() {
        return Realm.builder().sessionStore(new dev.realmid.sdk.session.MemorySessionStore())
                .realmId("01HREALM").apiKey("rk_live_test").baseUrl(fs.baseUrl).audience("acme.test").build();
    }

    private String issuerIp(String path) {
        String ip = null;
        int n = 0;
        for (FakeServer.Recorded r : fs.recorded) {
            if (r.path.equals(path)) { ip = r.header("x-on-behalf-of-ip"); n++; }
        }
        assertEquals(1, n, "issuer calls to " + path);
        return ip;
    }

    private void post(MiddlewareConfig.Builder b, String path) throws Exception {
        RealmFilter f = b.recoveryPath("/mfa/recovery").buildFilter();
        RealmFilterTest.FakeReq req = new RealmFilterTest.FakeReq("POST", path);
        req.body = "{\"challenge_token\":\"c\",\"code\":\"1\"}".getBytes(StandardCharsets.UTF_8);
        req.headers.put("X-Real-IP", List.of("198.51.100.9"));
        req.headers.put("X-Forwarded-For", List.of("192.0.2.66")); // spoofable; never trusted by default
        RealmFilterTest.FakeRes res = new RealmFilterTest.FakeRes();
        f.doFilter(req, res, (rq, rs) -> { throw new AssertionError("chain must not run"); });
        assertEquals(200, res.status, new String(res.bytes(), StandardCharsets.UTF_8));
    }

    @Test
    void middlewareForwardsRemoteAddrOnVerifyAndRecovery() throws Exception {
        post(realm().middleware(), "/mfa/verify");
        post(realm().middleware(), "/mfa/recovery");
        assertEquals("127.0.0.1", issuerIp("/auth/mfa/verify"));
        assertEquals("127.0.0.1", issuerIp("/auth/mfa/recovery"));
    }

    @Test
    void clientIpHookWins() throws Exception {
        post(realm().middleware().clientIp(rq -> rq.getHeader("X-Real-IP")), "/mfa/verify");
        post(realm().middleware().clientIp(rq -> rq.getHeader("X-Real-IP")), "/mfa/recovery");
        assertEquals("198.51.100.9", issuerIp("/auth/mfa/verify"));
        assertEquals("198.51.100.9", issuerIp("/auth/mfa/recovery"));
    }

    @Test
    void directRequestsCarryOnBehalfOfIp() {
        Realm r = realm();
        r.auth().mfaVerify(MFAVerifyRequest.of("c", "1").withOnBehalfOfIp("198.51.100.7"));
        r.auth().redeemRecoveryCode(RedeemRecoveryCodeRequest.of("c", "abcd").withOnBehalfOfIp("198.51.100.8"));
        assertEquals("198.51.100.7", issuerIp("/auth/mfa/verify"));
        assertEquals("198.51.100.8", issuerIp("/auth/mfa/recovery"));
    }
}
