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
import static org.junit.jupiter.api.Assertions.assertNull;
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

    // Locks SPEC §4.1 refresh_exp + ADR-070 idle_ttl onto both the login
    // (Session) and token (TokenResponse) responses; absence must decode as 0
    // so the BFF can fall back to its own ceiling / treat idle-timeout as off.
    @Test
    void decodesRefreshExpAndIdleTtl() {
        fs.on("POST /auth/login", (ex, body) -> {
            Map<String, Object> b = fs.last().bodyAsMap();
            if ("platform_api_key".equals(b.get("grant_type"))) {
                return FakeServer.Reply.json(200, Map.of(
                        "access_token", "pt-12345", "refresh_token", "rt",
                        "expires_in", 300, "subject_type", "platform"));
            }
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "at-1", "refresh_token", "rt-1", "expires_in", 600,
                    "refresh_exp", 1_780_000_000L, "idle_ttl", 1800L,
                    "user", Map.of("id", "u1"), "tenants", java.util.List.of()));
        });
        Session s = realm.auth().login(LoginRequest.of("firebase", "provider-tok"));
        assertEquals(1_780_000_000L, s.refreshExp());
        assertEquals(1800L, s.idleTtl());

        fs.on("POST /auth/token", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                "access_token", "at-2", "refresh_token", "rt-2", "expires_in", 900,
                "refresh_exp", 1_780_000_000L, "idle_ttl", 1800L,
                "tenant_id", "t1", "role", "admin")));
        TokenResponse r = realm.auth().token(TokenRequest.of("rt-1", "t1"));
        assertEquals(1_780_000_000L, r.refreshExp());
        assertEquals(1800L, r.idleTtl());

        // Absent idle_ttl / refresh_exp must decode as 0.
        fs.on("POST /auth/token", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                "access_token", "at-3", "refresh_token", "rt-3", "expires_in", 900,
                "tenant_id", "t1", "role", "admin")));
        TokenResponse r2 = realm.auth().token(TokenRequest.of("rt-2", "t1"));
        assertEquals(0L, r2.idleTtl());
        assertEquals(0L, r2.refreshExp());
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
    void otpLoginSendsGrantTypeOtpWithIdentifierAndPresented() {
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
                    "initiated_by_user_id", "u-owner",
                    "tenants", java.util.List.of()));
        });
        Session s = realm.auth().otpLogin(OtpLoginRequest.of("+15551234567", "123456"));
        assertEquals("at-otp", s.accessToken());
        // ADR-071 §8 provenance decodes onto the session.
        assertEquals("u-owner", s.initiatedByUserId());
        // ADR-071 §4: grant_type=otp on the wire, deprecated `method` dropped.
        assertEquals("otp", seen.get().get("grant_type"));
        assertNull(seen.get().get("method"));
        assertEquals("+15551234567", seen.get().get("identifier"));
        assertEquals("123456", seen.get().get("presented"));
    }

    @Test
    void mfaVerifyOtpRoutesThroughMfaVerifyWithOtp() {
        AtomicReference<Map<String, Object>> seen = new AtomicReference<>();
        fs.on("POST /auth/mfa/verify", (ex, body) -> {
            seen.set(fs.last().bodyAsMap());
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "at-otp2", "refresh_token", "rt-otp2",
                    "expires_in", 900, "tenants", java.util.List.of()));
        });
        Session s = realm.auth().mfaVerifyOtp(MfaVerifyOtpRequest.of("ch-9", "654321"));
        assertEquals("at-otp2", s.accessToken());
        assertEquals("otp", seen.get().get("method"));
        assertEquals("ch-9", seen.get().get("mfa_challenge_token"));
        assertEquals("654321", seen.get().get("code"));
    }

    // ---- Self-service MFA (feature 1) ----

    @Test
    void enrollMfaRefreshAuthedDefaultsMethodSurfacesChallenge() {
        AtomicReference<FakeServer.Recorded> seen = new AtomicReference<>();
        fs.on("POST /auth/mfa/enroll", (ex, body) -> {
            seen.set(fs.last());
            return FakeServer.Reply.json(200, Map.of(
                    "secret", "JBSWY3DPEHPK3PXP",
                    "qr_url", "otpauth://totp/acme:u1?secret=JBSWY3DPEHPK3PXP",
                    "recovery_codes", java.util.List.of("aaa-111", "bbb-222"),
                    "mfa_challenge_token", "enroll-ch-1",
                    "tenant_id", "t1"));
        });
        MfaEnrollment e = realm.auth().enrollMfa(SelfEnrollMfaRequest.of("rt-user", "t1"));
        assertEquals("JBSWY3DPEHPK3PXP", e.secret());
        assertTrue(e.qrUrl().startsWith("otpauth://"));
        assertEquals(2, e.recoveryCodes().size());
        // Enroll-scoped challenge + tenant surfaced for a single-shot mfaVerify.
        assertEquals("enroll-ch-1", e.mfaChallengeToken());
        assertEquals("t1", e.tenantId());
        // Refresh-authed: the platform token is the bearer (auto-attached) and
        // the refresh + tenant ride in the body (mirrors token()).
        assertEquals("Bearer pt-12345", seen.get().header("authorization"));
        Map<String, Object> b = seen.get().bodyAsMap();
        assertEquals("rt-user", b.get("refresh_token"));
        assertEquals("t1", b.get("tenant_id"));
        // method omitted when not set; server defaults to "totp".
        assertFalse(b.containsKey("method"));
    }

    @Test
    void enrollMfaSendsExplicitMethod() {
        AtomicReference<FakeServer.Recorded> seen = new AtomicReference<>();
        fs.on("POST /auth/mfa/enroll", (ex, body) -> {
            seen.set(fs.last());
            return FakeServer.Reply.json(200, Map.of(
                    "secret", "S", "qr_url", "otpauth://x", "recovery_codes", java.util.List.of(),
                    "mfa_challenge_token", "enroll-ch-2", "tenant_id", "t2"));
        });
        realm.auth().enrollMfa(SelfEnrollMfaRequest.of("rt-user", "t2", "totp"));
        Map<String, Object> b = seen.get().bodyAsMap();
        assertEquals("rt-user", b.get("refresh_token"));
        assertEquals("t2", b.get("tenant_id"));
        assertEquals("totp", b.get("method"));
    }

    @Test
    void enrollMfaServerErrorSurfaces() {
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("error", Map.of("code", "conflict", "message", "already enrolled"));
        envelope.put("code", "already_enrolled");
        fs.on("POST /auth/mfa/enroll", (ex, body) -> FakeServer.Reply.json(409, envelope));
        RealmException ex = assertThrows(RealmException.class,
                () -> realm.auth().enrollMfa(SelfEnrollMfaRequest.of("rt-user", "t1")));
        assertEquals(409, ex.getHttpStatus());
        assertEquals("already_enrolled", ex.getDetails().get("code"));
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

    // ---- List sessions: last-used field drift guard ----

    @Test
    void listSessionsDecodesLastSeenAt() {
        // Mirrors issuer/internal/httpapi/sessions.go sessionDTO: the last-used
        // timestamp field is `last_seen_at`, NOT `last_used_at`. Before the fix
        // Session#lastUsedAt() always deserialized to null.
        fs.on("GET /auth/sessions", (ex, body) -> {
            assertEquals("Bearer user-jwt", fs.last().header("authorization"));
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("id", "sess-1");
            item.put("origin", "https://app.realmid.dev");
            item.put("device_name", "laptop");
            item.put("created_at", 1_751_241_600L);
            item.put("last_seen_at", 1_751_245_200L);
            return FakeServer.Reply.json(200, Map.of(
                    "items", java.util.List.of(item),
                    "next_cursor", ""));
        });
        java.util.List<Session> sessions = realm.auth().listSessions("user-jwt").stream().toList();
        assertEquals(1, sessions.size());
        Session s = sessions.get(0);
        assertEquals("sess-1", s.id());
        assertEquals("1751241600", s.createdAt());
        assertNotNull(s.lastUsedAt(), "lastUsedAt must decode from the wire last_seen_at field");
        assertEquals("1751245200", s.lastUsedAt());
    }
}
