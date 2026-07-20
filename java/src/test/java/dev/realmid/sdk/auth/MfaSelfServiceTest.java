package dev.realmid.sdk.auth;

import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.http.HttpClient;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** ADR-080 / issuer v0.50.0 — self-service MFA authenticator list + recovery regenerate. */
class MfaSelfServiceTest {
    private FakeServer fs;
    private Realm realm;

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        fs.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("access_token", "pt", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform")));
        realm = Realm.builder()
                .realmId("01HREALM")
                .apiKey("rk")
                .baseUrl(fs.baseUrl)
                .audience("acme.test")
                .httpClient(HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build())
                .build();
    }

    @AfterEach
    void tearDown() { fs.close(); }

    @Test
    void listAuthenticatorsLegacyBearerParsesList() {
        Map<String, Object> auth = new LinkedHashMap<>();
        auth.put("type", "totp");
        auth.put("confirmed", true);
        auth.put("created_at", 1700000000);
        auth.put("confirmed_at", 1700000100);
        fs.on("GET /auth/mfa/authenticators", (ex, body) -> {
            assertEquals("Bearer user-jwt", fs.last().header("authorization"));
            return FakeServer.Reply.json(200, Map.of(
                    "authenticators", List.of(auth), "backup_codes_remaining", 8));
        });
        AuthenticatorList out = realm.auth().listAuthenticators(
                ListAuthenticatorsRequest.withBearer("user-jwt"));
        assertEquals(8, out.backupCodesRemaining());
        assertEquals(1, out.authenticators().size());
        Authenticator a = out.authenticators().get(0);
        assertEquals("totp", a.type());
        assertTrue(a.confirmed());
        assertEquals(1700000000L, a.createdAt());
        assertEquals(1700000100L, a.confirmedAt());
    }

    @Test
    void listAuthenticatorsOnBehalfSendsHeader() {
        fs.on("GET /auth/mfa/authenticators", (ex, body) -> {
            assertEquals("u42", fs.last().header("x-on-behalf-of-user"));
            assertEquals("Bearer pt", fs.last().header("authorization"));
            return FakeServer.Reply.json(200, Map.of(
                    "authenticators", List.of(), "backup_codes_remaining", 0));
        });
        AuthenticatorList out = realm.auth().listAuthenticators(
                ListAuthenticatorsRequest.forUser("u42"));
        assertEquals(0, out.backupCodesRemaining());
        assertTrue(out.authenticators().isEmpty());
    }

    @Test
    void regenerateRecoveryCodesReturnsFreshSet() {
        fs.on("POST /auth/mfa/recovery/regenerate", (ex, body) -> {
            assertEquals("Bearer user-jwt", fs.last().header("authorization"));
            return FakeServer.Reply.json(200, Map.of(
                    "status", "ok", "recovery_codes", List.of("aaaa-bbbb", "cccc-dddd")));
        });
        RecoveryCodes out = realm.auth().regenerateRecoveryCodes(
                RegenerateRecoveryCodesRequest.withBearer("user-jwt"));
        assertEquals("ok", out.status());
        assertEquals(List.of("aaaa-bbbb", "cccc-dddd"), out.recoveryCodes());
    }

    @Test
    void regenerateRecoveryCodesMfaRequiredSurfaces412() {
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("error", "step-up required");
        envelope.put("code", "mfa_required");
        fs.on("POST /auth/mfa/recovery/regenerate", (ex, body) -> FakeServer.Reply.json(412, envelope));
        RealmException ex = assertThrows(RealmException.class, () ->
                realm.auth().regenerateRecoveryCodes(RegenerateRecoveryCodesRequest.withBearer("user-jwt")));
        assertEquals(ErrorCode.MFA_REQUIRED, ex.getCode());
        assertEquals(412, ex.getHttpStatus());
    }

    @Test
    void regenerateRecoveryCodesNotEnrolledSurfaces409() {
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("error", "no confirmed authenticator");
        envelope.put("code", "not_enrolled");
        fs.on("POST /auth/mfa/recovery/regenerate", (ex, body) -> FakeServer.Reply.json(409, envelope));
        RealmException ex = assertThrows(RealmException.class, () ->
                realm.auth().regenerateRecoveryCodes(RegenerateRecoveryCodesRequest.forUser("u1")));
        // not_enrolled is not in the ErrorCode enum → falls back to the 409 status code.
        assertEquals(ErrorCode.CONFLICT, ex.getCode());
        assertEquals(409, ex.getHttpStatus());
        assertFalse(ex.getDetails().containsKey("error"));
    }
}
