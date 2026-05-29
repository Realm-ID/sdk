package dev.realmid.sdk.auth;

import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AuthClientTest {
    private FakeServer fs;
    private Realm realm;

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        // Default platform-token mint
        fs.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("access_token", "pt-12345", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform")));
        realm = Realm.builder()
                .realmId("01HREALM")
                .apiKey("rk_live_test")
                .baseUrl(fs.baseUrl)
                .audience("acme.test")
                .build();
    }

    @AfterEach
    void tearDown() { fs.close(); }

    @Test
    void loginHappyPath() {
        AtomicReference<FakeServer.Recorded> seen = new AtomicReference<>();
        // The platform bootstrap and the user login both hit POST /auth/login,
        // distinguished by grant_type (ADR-051). Branch on it.
        fs.on("POST /auth/login", (ex, body) -> {
            Map<String, Object> b = fs.last().bodyAsMap();
            if ("platform_api_key".equals(b.get("grant_type"))) {
                return FakeServer.Reply.json(200, Map.of(
                        "access_token", "pt-12345", "refresh_token", "rt",
                        "expires_in", 300, "subject_type", "platform"));
            }
            seen.set(fs.last());
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "at-1",
                    "refresh_token", "rt-1",
                    "expires_in", 600,
                    "user", Map.of("id", "u1"),
                    "tenants", java.util.List.of()));
        });
        Session s = realm.auth().login(LoginRequest.of("firebase", "provider-tok"));
        assertEquals("at-1", s.accessToken());
        assertEquals("rt-1", s.refreshToken());
        // Must use the platform token, not raw API key.
        assertEquals("Bearer pt-12345", seen.get().header("authorization"));
    }

    @Test
    void loginMfaRequired() {
        fs.on("POST /auth/login", (ex, body) -> {
            Map<String, Object> b = fs.last().bodyAsMap();
            if ("platform_api_key".equals(b.get("grant_type"))) {
                return FakeServer.Reply.json(200, Map.of(
                        "access_token", "pt-12345", "refresh_token", "rt",
                        "expires_in", 300, "subject_type", "platform"));
            }
            return FakeServer.Reply.json(412, Map.of(
                    "error", Map.of("code", "mfa_required", "message", "MFA required"),
                    "mfa_challenge_token", "ch-token-abc",
                    "methods", java.util.List.of("totp")));
        });
        RealmException ex = assertThrows(RealmException.class,
                () -> realm.auth().login(LoginRequest.of("firebase", "tok")));
        assertEquals(ErrorCode.MFA_REQUIRED, ex.getCode());
        assertEquals("ch-token-abc", ex.getDetails().get("mfa_challenge_token"));
    }

    @Test
    void tokenRefreshWithCustomClaims() {
        AtomicReference<Map<String, Object>> seen = new AtomicReference<>();
        fs.on("POST /auth/token", (ex, body) -> {
            seen.set(fs.last().bodyAsMap());
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "at-2",
                    "refresh_token", "rt-2",
                    "expires_in", 900,
                    "tenant_id", "t1",
                    "role", "admin"));
        });
        TokenResponse r = realm.auth().token(TokenRequest.withClaims(
                "rt-1", "t1", Map.of("outlet_ids", java.util.List.of("o1"))));
        assertEquals("at-2", r.accessToken());
        assertEquals("admin", r.role());
        assertNotNull(seen.get().get("custom_claims"));
        @SuppressWarnings("unchecked")
        Map<String, Object> cc = (Map<String, Object>) seen.get().get("custom_claims");
        assertTrue(cc.containsKey("outlet_ids"));
    }

    @Test
    void logout() {
        fs.on("POST /auth/logout", (ex, body) -> FakeServer.Reply.json(200, Map.of("status", "ok")));
        Map<String, Object> r = realm.auth().logout(LogoutRequest.of("rt-1"));
        assertEquals("ok", r.get("status"));
    }

    @Test
    void mfaVerifySendsMfaChallengeTokenWireField() {
        AtomicReference<Map<String, Object>> seen = new AtomicReference<>();
        fs.on("POST /auth/mfa/verify", (ex, body) -> {
            seen.set(fs.last().bodyAsMap());
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "at-mfa", "refresh_token", "rt-mfa",
                    "expires_in", 600, "tenants", java.util.List.of()));
        });
        Session s = realm.auth().mfaVerify(new MFAVerifyRequest("ch-token-abc", "123456", "totp", null));
        assertEquals("at-mfa", s.accessToken());
        // Issuer requires "mfa_challenge_token" (MFAVerifyRequest required:
        // [mfa_challenge_token, code]); the legacy "challenge_token" must NOT
        // be sent.
        assertEquals("ch-token-abc", seen.get().get("mfa_challenge_token"));
        assertFalse(seen.get().containsKey("challenge_token"));
        assertEquals("123456", seen.get().get("code"));
        assertEquals("totp", seen.get().get("method"));
    }

    // ---- Partner OTP login / verify (SPEC §X.4 / §X.5) ----

    @Test
    void otpLoginSendsMethodOtpInternalWithIdentifierAndPresented() {
        AtomicReference<Map<String, Object>> seen = new AtomicReference<>();
        fs.on("POST /auth/login", (ex, body) -> {
            Map<String, Object> b = fs.last().bodyAsMap();
            if ("platform_api_key".equals(b.get("grant_type"))) {
                return FakeServer.Reply.json(200, Map.of(
                        "access_token", "pt-12345", "refresh_token", "rt",
                        "expires_in", 300, "subject_type", "platform"));
            }
            seen.set(b);
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "at-otp", "refresh_token", "rt-otp",
                    "expires_in", 900, "user", Map.of("id", "u-bob"),
                    "tenants", java.util.List.of()));
        });
        Session s = realm.auth().otpLogin(OtpLoginRequest.of("+15551234567", "123456"));
        assertEquals("at-otp", s.accessToken());
        assertEquals("otp_internal", seen.get().get("method"));
        assertEquals("+15551234567", seen.get().get("identifier"));
        assertEquals("123456", seen.get().get("presented"));
    }

    @Test
    void mfaVerifyOtpRoutesThroughMfaVerifyWithOtpInternal() {
        AtomicReference<Map<String, Object>> seen = new AtomicReference<>();
        fs.on("POST /auth/mfa/verify", (ex, body) -> {
            seen.set(fs.last().bodyAsMap());
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "at-otp2", "refresh_token", "rt-otp2",
                    "expires_in", 900, "tenants", java.util.List.of()));
        });
        Session s = realm.auth().mfaVerifyOtp(MfaVerifyOtpRequest.of("ch-9", "654321"));
        assertEquals("at-otp2", s.accessToken());
        assertEquals("otp_internal", seen.get().get("method"));
        assertEquals("ch-9", seen.get().get("mfa_challenge_token"));
        assertEquals("654321", seen.get().get("code"));
    }

    // ---- Self-service MFA (feature 1) ----

    @Test
    void enrollMfaLegacyBearerOmitsMethod() {
        fs.on("POST /auth/mfa/enroll", (ex, body) -> {
            FakeServer.Recorded rec = fs.last();
            // Legacy mode: the user's own access JWT is the Authorization bearer.
            assertEquals("Bearer user-jwt", rec.header("authorization"));
            // method omitted when not set.
            assertFalse(rec.bodyAsMap().containsKey("method"));
            return FakeServer.Reply.json(200, Map.of(
                    "secret", "JBSWY3DPEHPK3PXP",
                    "qr_url", "otpauth://totp/acme:u1?secret=JBSWY3DPEHPK3PXP",
                    "recovery_codes", java.util.List.of("aaa-111", "bbb-222")));
        });
        MfaEnrollment e = realm.auth().enrollMfa(EnrollMfaRequest.withBearer("user-jwt"));
        assertEquals("JBSWY3DPEHPK3PXP", e.secret());
        assertTrue(e.qrUrl().startsWith("otpauth://"));
        assertEquals(2, e.recoveryCodes().size());
    }

    @Test
    void enrollMfaBffModeSendsOnBehalfHeader() {
        AtomicReference<FakeServer.Recorded> seen = new AtomicReference<>();
        fs.on("POST /auth/mfa/enroll", (ex, body) -> {
            seen.set(fs.last());
            return FakeServer.Reply.json(200, Map.of(
                    "secret", "S", "qr_url", "otpauth://x", "recovery_codes", java.util.List.of()));
        });
        realm.auth().enrollMfa(new EnrollMfaRequest("u1", null, "203.0.113.7", "totp"));
        // BFF mode: platform token + on-behalf-of headers.
        assertEquals("Bearer pt-12345", seen.get().header("authorization"));
        assertEquals("u1", seen.get().header("x-on-behalf-of-user"));
        assertEquals("203.0.113.7", seen.get().header("x-on-behalf-of-ip"));
        assertEquals("totp", seen.get().bodyAsMap().get("method"));
    }

    @Test
    void enrollMfaRejectsBothBearerAndUserId() {
        RealmException ex = assertThrows(RealmException.class,
                () -> realm.auth().enrollMfa(new EnrollMfaRequest("u1", "user-jwt", null, null)));
        assertEquals(ErrorCode.BAD_REQUEST, ex.getCode());
    }

    @Test
    void confirmMfaSendsCodeReturnsVoid() {
        fs.on("POST /auth/mfa/confirm", (ex, body) -> {
            assertEquals("123456", fs.last().bodyAsMap().get("code"));
            return FakeServer.Reply.json(200, Map.of("status", "confirmed"));
        });
        realm.auth().confirmMfa(ConfirmMfaRequest.withBearer("user-jwt", "123456"));
    }

    @Test
    void confirmMfaMissingCodeSurfacesError() {
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("error", Map.of("code", "bad_request", "message", "missing code"));
        envelope.put("code", "missing_code");
        fs.on("POST /auth/mfa/confirm", (ex, body) -> FakeServer.Reply.json(400, envelope));
        RealmException ex = assertThrows(RealmException.class,
                () -> realm.auth().confirmMfa(ConfirmMfaRequest.withBearer("user-jwt", "")));
        assertEquals(400, ex.getHttpStatus());
        assertEquals("missing_code", ex.getDetails().get("code"));
    }

    @Test
    void disableMfaSendsCodeInDeleteBody() {
        fs.on("DELETE /auth/mfa", (ex, body) -> {
            assertEquals("654321", fs.last().bodyAsMap().get("code"));
            assertEquals("Bearer user-jwt", fs.last().header("authorization"));
            return FakeServer.Reply.json(200, Map.of("status", "disabled"));
        });
        realm.auth().disableMfa(DisableMfaRequest.withBearer("user-jwt", "654321"));
    }

    @Test
    void disableMfaNotEnrolledSurfacesError() {
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("error", Map.of("code", "bad_request", "message", "not enrolled"));
        envelope.put("code", "not_enrolled");
        fs.on("DELETE /auth/mfa", (ex, body) -> FakeServer.Reply.json(400, envelope));
        RealmException ex = assertThrows(RealmException.class,
                () -> realm.auth().disableMfa(DisableMfaRequest.withBearer("user-jwt", "654321")));
        assertEquals("not_enrolled", ex.getDetails().get("code"));
    }

    // ---- Revoke all sessions (feature 3) ----

    @Test
    void revokeAllSessionsLegacyBearer() {
        fs.on("DELETE /auth/sessions", (ex, body) -> {
            assertEquals("Bearer user-jwt", fs.last().header("authorization"));
            return FakeServer.Reply.json(200, Map.of("status", "ok"));
        });
        realm.auth().revokeAllSessions(RevokeAllSessionsRequest.withBearer("user-jwt"));
    }

    @Test
    void revokeAllSessionsInsufficientScopeSurfaces() {
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("error", Map.of("code", "forbidden", "message", "revocation token"));
        envelope.put("code", "insufficient_scope");
        fs.on("DELETE /auth/sessions", (ex, body) -> FakeServer.Reply.json(403, envelope));
        RealmException ex = assertThrows(RealmException.class,
                () -> realm.auth().revokeAllSessions(RevokeAllSessionsRequest.withBearer("user-jwt")));
        assertEquals(403, ex.getHttpStatus());
        assertEquals("insufficient_scope", ex.getDetails().get("code"));
    }
}
