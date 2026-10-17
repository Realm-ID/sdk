package dev.realmid.sdk.messaging;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import dev.realmid.sdk.idp.IdentityProvidersResponse;
import dev.realmid.sdk.info.RealmConfigResponse;
import dev.realmid.sdk.otp.OtpIssueRequest;
import dev.realmid.sdk.otp.OtpIssueResponse;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.http.HttpClient;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Bring-your-own phone delivery (ADR-115, issuer spec 0.60.0): SPEC §6.16 /
 * §3.1 channel codes / §4.1.4a / §X.1 / §6.5. Mirrors go/messaging_test.go.
 * The issuer answers the messaging routes with a BARE body, not {"data":...}.
 */
class MessagingClientTest {
    private static final ObjectMapper M = new ObjectMapper();
    private static final String PATH = "/platforms/01HREALM/messaging/";
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

    @Test
    void putSmsSendsTwilioFieldsAndDecodesReadShape() {
        Map<String, Object> reply = new LinkedHashMap<>();
        reply.put("channel", "sms"); reply.put("provider", "twilio"); reply.put("secret_hint", "c0de");
        reply.put("status", "operational"); reply.put("status_reason", null);
        reply.put("status_changed_at", "2026-10-17T10:00:00Z");
        reply.put("validated_at", "2026-10-17T10:00:00Z"); reply.put("updated_at", "2026-10-17T10:00:00Z");
        reply.put("account_sid", "AC1"); reply.put("api_key_sid", "SK1"); reply.put("from_number", "+15551234567");
        fs.on("PUT " + PATH + "sms", (ex, body) -> FakeServer.Reply.json(200, reply));

        MessagingChannel got = realm.messaging().putSms(TwilioChannel.builder()
                .accountSid("AC1").apiKeySid("SK1").apiKeySecret("shh-c0de").fromNumber("+15551234567").build());

        FakeServer.Recorded rec = fs.last();
        assertEquals("PUT", rec.method);
        assertEquals(PATH + "sms", rec.path);
        assertEquals("Bearer pt", rec.header("Authorization"));
        assertEquals(Map.of("account_sid", "AC1", "api_key_sid", "SK1",
                "api_key_secret", "shh-c0de", "from_number", "+15551234567"), rec.bodyAsMap(),
                "unset fields must be omitted");
        assertEquals(MessagingChannel.SMS, got.channel());
        assertEquals("twilio", got.provider());
        assertEquals("c0de", got.secretHint());
        assertEquals(MessagingChannel.STATUS_OPERATIONAL, got.status());
        assertNull(got.statusReason());
        assertEquals("2026-10-17T10:00:00Z", got.validatedAt());
        assertEquals("2026-10-17T10:00:00Z", got.updatedAt());
        assertEquals("+15551234567", got.fromNumber());
    }

    private static Map<String, Object> waReply(String... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) m.put(kv[i], kv[i + 1]);
        return m;
    }

    @Test
    void putWhatsAppSendsMetaFields() {
        fs.on("PUT " + PATH + "whatsapp", (ex, body) -> FakeServer.Reply.json(200, waReply(
                "channel", "whatsapp", "provider", "meta", "secret_hint", "ABCD", "status", "failing",
                "status_reason", "token revoked", "status_changed_at", "2026-10-17T10:00:00Z",
                "updated_at", "2026-10-17T10:00:00Z", "phone_number_id", "111", "waba_id", "222",
                "template_name", "otp_login", "template_language", "en_US")));
        MessagingChannel got = realm.messaging().putWhatsApp(
                new WhatsAppChannel("111", "222", "EAAB-ABCD", "otp_login", "en_US"));
        assertEquals(Map.of("phone_number_id", "111", "waba_id", "222", "access_token", "EAAB-ABCD",
                "template_name", "otp_login", "template_language", "en_US"), fs.last().bodyAsMap());
        assertEquals(MessagingChannel.STATUS_FAILING, got.status());
        assertEquals("token revoked", got.statusReason());
        assertNull(got.validatedAt());
        assertEquals("otp_login", got.templateName());
    }

    @Test
    void secretsNeverPrint() {
        String t = TwilioChannel.builder().accountSid("AC1").authToken("SECRET-A").apiKeySecret("SECRET-B").build().toString();
        assertFalse(t.contains("SECRET"), t);
        String w = new WhatsAppChannel("1", "2", "SECRET-C", "t", "en").toString();
        assertFalse(w.contains("SECRET"), w);
        // The read type has no secret accessor at all: only the hint.
        for (var m : MessagingChannel.class.getMethods()) {
            String n = m.getName().toLowerCase();
            assertFalse(n.contains("token") || n.contains("secret") && !n.contains("hint"), n);
        }
    }

    @Test
    void getNotConfiguredIsRegisteredCode() {
        fs.on("GET " + PATH + "sms", (ex, body) -> FakeServer.Reply.json(404, err("channel_not_configured", "nothing saved")));
        RealmException e = assertThrows(RealmException.class, () -> realm.messaging().get("sms"));
        assertEquals(ErrorCode.CHANNEL_NOT_CONFIGURED, e.getCode());
        assertTrue(RealmException.isChannelNotConfigured(e));
        assertFalse(RealmException.isChannelNotConfigured(null));
    }

    @Test
    void deleteReturnsStatus() {
        fs.on("DELETE " + PATH + "whatsapp", (ex, body) -> FakeServer.Reply.json(200, Map.of("status", "deleted")));
        assertEquals("deleted", realm.messaging().delete("whatsapp").status());
        assertEquals("DELETE", fs.last().method);
    }

    @Test
    void unknownChannelRejectedBeforeNetwork() {
        int before = fs.recorded.size();
        for (String bad : new String[]{"voice", "sms/../x", "", null}) {
            RealmException e = assertThrows(RealmException.class, () -> realm.messaging().get(bad));
            assertEquals(ErrorCode.BAD_REQUEST, e.getCode());
        }
        assertThrows(RealmException.class, () -> realm.messaging().delete("telegram"));
        assertEquals(before, fs.recorded.size(), "no request may leave for a bad channel");
    }

    @Test
    void putErrorsLandOnRegisteredCodes() {
        fs.on("PUT " + PATH + "sms", (ex, body) -> FakeServer.Reply.json(400, err("invalid_channel_config", "from_number: must be E.164")));
        RealmException a = assertThrows(RealmException.class,
                () -> realm.messaging().putSms(TwilioChannel.builder().accountSid("AC1").build()));
        assertEquals(ErrorCode.INVALID_CHANNEL_CONFIG, a.getCode());
        assertTrue(RealmException.isInvalidChannelConfig(a));
        assertTrue(a.getMessage().contains("E.164"));

        fs.on("PUT " + PATH + "sms", (ex, body) -> FakeServer.Reply.json(422, err("channel_validation_failed", "Twilio: bad auth")));
        RealmException b = assertThrows(RealmException.class,
                () -> realm.messaging().putSms(TwilioChannel.builder().accountSid("AC1").build()));
        assertEquals(ErrorCode.CHANNEL_VALIDATION_FAILED, b.getCode());
        assertTrue(RealmException.isChannelValidationFailed(b));
    }

    @Test
    void phoneOtpRateLimitedRegisteredAndNotGenericRateLimited() {
        fs.on("POST /auth/otp/issue", (ex, body) -> FakeServer.Reply.json(429, err("phone_otp_rate_limited", "too many")));
        RealmException e = assertThrows(RealmException.class, () -> realm.otp().issue(
                new OtpIssueRequest("user:u1", "login", "u1", null, null, OtpIssueRequest.DELIVERY_MODE_WHATSAPP)));
        assertEquals(ErrorCode.PHONE_OTP_RATE_LIMITED, e.getCode());
        assertTrue(RealmException.isPhoneOtpRateLimited(e));
        assertNotEquals(ErrorCode.RATE_LIMITED, e.getCode());
    }

    @Test
    void whatsAppModeAndDeliveredEcho() {
        assertEquals("whatsapp", OtpIssueRequest.DELIVERY_MODE_WHATSAPP);
        fs.on("POST /auth/otp/issue", (ex, body) -> FakeServer.Reply.json(200, Map.of("id", "otp-1",
                "delivered", "whatsapp", "expires_at", "2026-10-17T12:00:00Z", "purpose", "login", "subject_ref", "user:u1")));
        OtpIssueResponse r = realm.otp().issue(new OtpIssueRequest("user:u1", "login", "u1", null, null,
                OtpIssueRequest.DELIVERY_MODE_WHATSAPP));
        assertEquals("whatsapp", fs.last().bodyAsMap().get("delivery_mode"));
        assertEquals("whatsapp", r.delivered());
        assertNull(r.value());
        // the pre-existing 5-arg constructor still works
        assertNull(new OtpIssueResponse("i", "v", "e", "p", "s").delivered());
    }

    @Test
    void deliveryUnavailableStaysUnregisteredAndCarriesChannel() {
        assertNull(ErrorCode.fromWire("delivery_unavailable"));
        assertNull(ErrorCode.fromWire("channel_unavailable"));
        fs.on("POST /auth/otp/issue", (ex, body) -> FakeServer.Reply.json(503, Map.of("error", Map.of(
                "code", "delivery_unavailable", "message", "whatsapp is not available", "channel", "whatsapp"))));
        RealmException e = assertThrows(RealmException.class, () -> realm.otp().issue(
                new OtpIssueRequest("user:u1", "login", "u1", null, null, OtpIssueRequest.DELIVERY_MODE_WHATSAPP)));
        assertEquals("delivery_unavailable", e.getDetails().get("server_code"));
        assertEquals("whatsapp", e.getDetails().get("channel"));
        assertEquals(503, e.getHttpStatus());
    }

    private static IdentityProvidersResponse idp(String json) throws Exception {
        return M.readValue(json, IdentityProvidersResponse.class);
    }

    private static JsonNode reserialise(IdentityProvidersResponse r) throws Exception {
        return M.readTree(M.writeValueAsString(r));
    }

    @Test
    void phoneChannelsAbsentVersusEmptySurvivesRoundTrip() throws Exception {
        IdentityProvidersResponse full = idp("{\"providers\":[],\"credential_methods\":[\"otp\"],\"phone_channels\":[\"whatsapp\",\"sms\"]}");
        assertEquals(List.of("whatsapp", "sms"), full.phoneChannels());
        JsonNode wire = reserialise(full).get("phone_channels");
        assertEquals("whatsapp", wire.get(0).asText());
        assertEquals("sms", wire.get(1).asText());
        assertTrue(full.offersPhoneLogin());

        IdentityProvidersResponse empty = idp("{\"providers\":[],\"credential_methods\":[\"otp\"],\"phone_channels\":[]}");
        assertNotNull(empty.phoneChannels());
        assertTrue(reserialise(empty).has("phone_channels"), "[] must survive as []");
        assertEquals(0, reserialise(empty).get("phone_channels").size());
        assertFalse(empty.offersPhoneLogin());

        IdentityProvidersResponse absent = idp("{\"providers\":[],\"credential_methods\":[\"otp\"]}");
        assertNull(absent.phoneChannels());
        assertFalse(reserialise(absent).has("phone_channels"), "absent must stay absent");
        assertFalse(absent.offersPhoneLogin());

        assertFalse(idp("{\"providers\":[],\"credential_methods\":[\"password\"],\"phone_channels\":[\"sms\"]}").offersPhoneLogin());
        // pre-existing constructors still compile and mean "absent"
        assertNull(new IdentityProvidersResponse(null, List.of(), List.of("otp")).phoneChannels());
        assertNull(new IdentityProvidersResponse(null, List.of(), List.of("otp"), null).phoneChannels());
    }

    @Test
    void phoneOtpConfigView() throws Exception {
        RealmConfigResponse r = M.readValue(
                "{\"id\":\"r\",\"config\":{\"idle_ttl_seconds\":0,\"phone_otp\":{\"max_per_window\":5,\"window_seconds\":900}}}",
                RealmConfigResponse.class);
        var p = r.phoneOtp().orElseThrow();
        assertEquals(5, p.maxPerWindow());
        assertEquals(900, p.windowSeconds());
        assertTrue(M.readValue("{\"id\":\"r\",\"config\":{}}", RealmConfigResponse.class).phoneOtp().isEmpty(),
                "absent is empty, not zeros");
        assertTrue(M.readValue("{\"id\":\"r\",\"config\":{\"phone_otp\":\"garbage\"}}", RealmConfigResponse.class).phoneOtp().isEmpty());
        assertTrue(M.readValue("{\"id\":\"r\",\"config\":{\"phone_otp\":{\"max_per_window\":5}}}", RealmConfigResponse.class).phoneOtp().isEmpty());
    }
}
