package dev.realmid.sdk.auth;

import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
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
        fs.on("POST /auth/platform-token", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("platform_token", "pt-12345", "expires_in", 300)));
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
        fs.on("POST /auth/login", (ex, body) -> {
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
        fs.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(412, Map.of(
                "error", Map.of("code", "mfa_required", "message", "MFA required"),
                "mfa_challenge_token", "ch-token-abc",
                "methods", java.util.List.of("totp"))));
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
}
