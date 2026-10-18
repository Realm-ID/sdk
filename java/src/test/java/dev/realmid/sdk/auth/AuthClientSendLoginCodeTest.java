package dev.realmid.sdk.auth;

import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import dev.realmid.sdk.info.RealmConfigResponse;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.http.HttpClient;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * SPEC X.4a / 3.1 / 6.5 (issuer ADR-116, spec 0.61.0): auth().sendLoginCode, the three sign-in
 * code send codes, the helpers, and phone_otp.sign_in_per_ip_per_hour. Mirrors
 * go/auth_sendlogin_test.go. The issuer answers 202 with a BARE body, not {"data":...}.
 */
class AuthClientSendLoginCodeTest {
    private FakeServer fs;
    private Realm realm;

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        fs.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("access_token", "pt", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform")));
        realm = Realm.builder().sessionStore(new dev.realmid.sdk.session.MemorySessionStore())
                .realmId("01HREALM").apiKey("rk").baseUrl(fs.baseUrl).audience("acme.test")
                .httpClient(HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build())
                .build();
    }

    @AfterEach
    void tearDown() { fs.close(); }

    private static Map<String, Object> err(String code, String msg) {
        return Map.of("error", Map.of("code", code, "message", msg));
    }

    private RealmException sendFailing(int status, Map<String, Object> body) {
        fs.on("POST /auth/otp/send-login", (ex, b) -> FakeServer.Reply.json(status, body));
        return assertThrows(RealmException.class,
                () -> realm.auth().sendLoginCode(new SendLoginCodeRequest("+919999000011", "sms", null, null)));
    }

    @Test
    void sendsRequestShapeAndDecodesBareBody() {
        fs.on("POST /auth/otp/send-login", (ex, b) -> FakeServer.Reply.json(202, Map.of("sent_if_registered", true)));
        SendLoginCodeResponse out = realm.auth().sendLoginCode(
                new SendLoginCodeRequest("+919999000011", "sms", "t-1", "203.0.113.9"));
        assertTrue(out.sentIfRegistered());
        FakeServer.Recorded rec = fs.last();
        assertEquals("POST", rec.method);
        assertEquals("/auth/otp/send-login", rec.path);
        assertEquals("Bearer pt", rec.header("Authorization"));
        assertEquals("203.0.113.9", rec.header("X-On-Behalf-Of-IP"));
        Map<String, Object> body = rec.bodyAsMap();
        assertEquals("+919999000011", body.get("identifier"));
        assertEquals("sms", body.get("delivery_mode"));
        assertEquals("t-1", body.get("tenant_id"));
        assertNull(body.get("realm_id"));
    }

    @Test
    void omitsTenantAndIpHeaderWhenAbsent() {
        fs.on("POST /auth/otp/send-login", (ex, b) -> FakeServer.Reply.json(202, Map.of("sent_if_registered", true)));
        realm.auth().sendLoginCode(SendLoginCodeRequest.of("+919999000011", "whatsapp"));
        FakeServer.Recorded rec = fs.last();
        assertNull(rec.header("X-On-Behalf-Of-IP"));
        assertFalse(rec.bodyAsMap().containsKey("tenant_id"));
        assertEquals("whatsapp", rec.bodyAsMap().get("delivery_mode"));
    }

    @Test
    void newCodesRegisteredAndNotDuplicatedIntoServerCode() {
        RealmException a = sendFailing(429, err("sign_in_ip_rate_limited", "m"));
        assertEquals(ErrorCode.SIGN_IN_IP_RATE_LIMITED, a.getCode());
        assertTrue(RealmException.isSignInIpRateLimited(a));
        assertFalse(RealmException.isPhoneOtpRateLimited(a));
        assertTrue(a.getDetails() == null || !a.getDetails().containsKey("server_code"));

        RealmException b = sendFailing(400, err("invalid_on_behalf_of_ip", "m"));
        assertEquals(ErrorCode.INVALID_ON_BEHALF_OF_IP, b.getCode());
    }

    @Test
    void methodNotEnabledNowOnCodeNotServerCode() {
        RealmException e = sendFailing(403, err("method_not_enabled", "off"));
        assertEquals(ErrorCode.METHOD_NOT_ENABLED, e.getCode());
        assertTrue(e.getDetails() == null || !e.getDetails().containsKey("server_code"));
        // the ADR-094 domain-SSO routes answer it as 400: same registered code
        RealmException sso = sendFailing(400, err("method_not_enabled", "off"));
        assertEquals(ErrorCode.METHOD_NOT_ENABLED, sso.getCode());
        assertTrue(sso.getDetails() == null || !sso.getDetails().containsKey("server_code"));
    }

    @Test
    void deliveryUnavailableStaysUnregisteredAndHelperReadsServerCode() {
        RealmException e = sendFailing(503, Map.of("error",
                Map.of("code", "delivery_unavailable", "message", "m", "channel", "sms")));
        assertTrue(RealmException.isDeliveryUnavailable(e));
        assertEquals("delivery_unavailable", e.getDetails().get("server_code"));
        assertFalse(RealmException.isDeliveryUnavailable(sendFailing(503, err("store_unavailable", "m"))));
        assertFalse(RealmException.isDeliveryUnavailable(null));
        assertFalse(RealmException.isDeliveryUnavailable(new RuntimeException("x")));
    }

    @Test
    void phoneOtpConfigCarriesSignInPerIpPerHour() throws Exception {
        RealmConfigResponse r = new com.fasterxml.jackson.databind.ObjectMapper().readValue(
                "{\"id\":\"r\",\"config\":{\"phone_otp\":{\"max_per_window\":5,\"window_seconds\":900,\"sign_in_per_ip_per_hour\":10}}}",
                RealmConfigResponse.class);
        assertEquals(10, r.phoneOtp().orElseThrow().signInPerIpPerHour());
        assertEquals(5, r.phoneOtp().orElseThrow().maxPerWindow());
    }
}
