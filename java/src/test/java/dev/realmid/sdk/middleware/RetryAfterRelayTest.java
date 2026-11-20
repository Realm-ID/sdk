package dev.realmid.sdk.middleware;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.middleware.RealmFilterTest.FakeReq;
import dev.realmid.sdk.middleware.RealmFilterTest.FakeRes;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/** The issuer's Retry-After on a refusal the filter answers is relayed to the browser. */
class RetryAfterRelayTest {
    private static final String REALM_ID = "01HREALM";
    private FakeServer api;

    @BeforeEach
    void setUp() throws Exception { api = new FakeServer(); }

    @AfterEach
    void tearDown() { api.close(); }

    private FakeRes loginRefused(int status, String code, String retryAfter) throws Exception {
        api.on("POST /auth/login", (ex, body) -> {
            String b = new String(body, StandardCharsets.UTF_8);
            if (b.contains("platform_api_key")) {
                return FakeServer.Reply.json(200, Map.of("access_token", "pt", "refresh_token", "rt",
                        "expires_in", 300, "subject_type", "platform"));
            }
            if (retryAfter != null) ex.getResponseHeaders().add("Retry-After", retryAfter);
            return FakeServer.Reply.json(status, Map.of("error", Map.of("code", code, "message", "slow down")));
        });
        Realm realm = Realm.builder().sessionStore(new dev.realmid.sdk.session.MemorySessionStore())
                .realmId(REALM_ID).apiKey("rk").baseUrl(api.baseUrl).audience("acme.test").build();
        RealmFilter f = realm.middleware().buildFilter();
        FakeReq req = new FakeReq("POST", "/login");
        req.body = "{\"grant_type\":\"provider_token\",\"method\":\"firebase\",\"provider_token\":\"x\"}"
                .getBytes(StandardCharsets.UTF_8);
        FakeRes res = new FakeRes();
        f.doFilter(req, res, (rq, rs) -> { throw new AssertionError(); });
        return res;
    }

    @Test
    void a429CarryingRetryAfterIsRelayed() throws Exception {
        FakeRes res = loginRefused(429, "sign_in_ip_rate_limited", "37");
        assertEquals(429, res.status);
        assertEquals(List.of("37"), res.headers.getOrDefault("Retry-After", List.of()));
    }

    @Test
    void refreshRelaysRetryAfterIncludingFromTheStoredOutcome() throws Exception {
        api.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200, Map.of("access_token", "pt",
                "refresh_token", "rt", "expires_in", 300, "subject_type", "platform")));
        // Only the first hit carries the header: a second answer that still has it came from storage.
        java.util.concurrent.atomic.AtomicInteger hits = new java.util.concurrent.atomic.AtomicInteger();
        api.on("POST /auth/token", (ex, body) -> {
            if (hits.incrementAndGet() == 1) ex.getResponseHeaders().add("Retry-After", "21");
            return FakeServer.Reply.json(429, Map.of("error", Map.of("code", "server_error", "message", "slow down")));
        });
        Realm realm = Realm.builder().sessionStore(new dev.realmid.sdk.session.MemorySessionStore())
                .realmId(REALM_ID).apiKey("rk").baseUrl(api.baseUrl).audience("acme.test").build();
        RealmFilter f = realm.middleware().buildFilter();
        for (int i = 0; i < 2; i++) { // the second call is answered from the stored outcome
            FakeReq req = new FakeReq("POST", "/token");
            req.headers.put("Cookie", List.of("realmid_refresh=rtok0"));
            req.body = "{\"tenant_id\":\"t1\"}".getBytes(StandardCharsets.UTF_8);
            FakeRes res = new FakeRes();
            f.doFilter(req, res, (rq, rs) -> { throw new AssertionError(); });
            assertEquals(429, res.status, "call " + i);
            assertEquals(List.of("21"), res.headers.getOrDefault("Retry-After", List.of()), "call " + i);
        }
        assertEquals(1, hits.get(), "the second answer must come from the stored outcome");
    }

    @Test
    void a503CarryingRetryAfterIsRelayedToo() throws Exception {
        FakeRes res = loginRefused(503, "server_error", "9");
        assertEquals(503, res.status);
        assertEquals(List.of("9"), res.headers.getOrDefault("Retry-After", List.of()));
    }

    @Test
    void aRefusalShownUnderADifferentStatusKeepsRetryAfter() throws Exception {
        FakeRes res = loginRefused(403, "escort_suspended", "5");
        assertEquals(503, res.status);
        assertEquals(List.of("5"), res.headers.getOrDefault("Retry-After", List.of()));
    }

    @Test
    void anIssuerAnswerWithoutRetryAfterProducesNone() throws Exception {
        FakeRes res = loginRefused(429, "sign_in_ip_rate_limited", null);
        assertTrue(res.headers.getOrDefault("Retry-After", List.of()).isEmpty());
    }
}
