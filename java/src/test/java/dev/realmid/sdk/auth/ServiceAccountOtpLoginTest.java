package dev.realmid.sdk.auth;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Owner ruling Q3 (2026-10-29): a service account pairs by OTP in ONE call to /auth/token with a
 * REQUIRED tenant_id; /auth/login stays people-only.
 */
class ServiceAccountOtpLoginTest {
    private FakeServer fs;
    private Realm realm;
    private final List<Map<String, Object>> otpCalls = new ArrayList<>();
    private int loginCalls;

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        fs.on("POST /auth/token", (ex, body) -> {
            Map<String, Object> b = fs.last().bodyAsMap();
            if ("platform_api_key".equals(b.get("grant_type"))) {
                return FakeServer.Reply.json(200, Map.of(
                        "access_token", "pt-12345", "expires_in", 300, "subject_type", "platform"));
            }
            otpCalls.add(b);
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "at-bot", "refresh_token", "rt-bot", "expires_in", 900,
                    "subject_type", "service", "tenant_id", "t1", "role", "member"));
        });
        // The fake routes the platform-token mint (a /auth/token call) to this handler; any OTHER
        // call here is a bot on the people-only route.
        fs.on("POST /auth/login", (ex, body) -> {
            if (!"platform_api_key".equals(fs.last().bodyAsMap().get("grant_type"))) loginCalls++;
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "pt-12345", "expires_in", 300, "subject_type", "platform"));
        });
        realm = Realm.builder().sessionStore(new dev.realmid.sdk.session.MemorySessionStore())
                .realmId("01HREALM").apiKey("rk_live_test").baseUrl(fs.baseUrl).audience("acme.test").build();
    }

    @AfterEach
    void tearDown() { fs.close(); }

    @Test
    void oneCallToAuthTokenWithTenantId() {
        TokenResponse r = realm.auth().serviceAccountOtpLogin(
                new ServiceAccountOtpLoginRequest("bot@example.com", "123456", "t1", null));
        assertEquals("at-bot", r.accessToken());
        assertEquals("rt-bot", r.refreshToken());
        assertEquals(1, otpCalls.size());
        assertEquals(0, loginCalls);
        assertEquals("otp", otpCalls.get(0).get("grant_type"));
        assertEquals("t1", otpCalls.get(0).get("tenant_id"));
        assertEquals("bot@example.com", otpCalls.get(0).get("identifier"));
        assertEquals("123456", otpCalls.get(0).get("presented"));
    }

    @Test
    void missingTenantIdIsRefusedBeforeAnyRequest() {
        RealmException e = assertThrows(RealmException.class, () -> realm.auth().serviceAccountOtpLogin(
                new ServiceAccountOtpLoginRequest("bot@example.com", "123456", "", null)));
        assertEquals("missing_tenant_id", e.getDetails().get("server_code"));
        assertTrue(otpCalls.isEmpty());
    }
}
