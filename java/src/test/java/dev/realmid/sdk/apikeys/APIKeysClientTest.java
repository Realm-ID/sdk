package dev.realmid.sdk.apikeys;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** SPEC §6.5 — api-key DTO alignment (role/prefix/unix-second timestamps; one-time value). */
class APIKeysClientTest {
    private static final String REALM_ID = "01HREALM";
    private FakeServer fs;
    private Realm realm;

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        fs.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                "access_token", "pt", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform")));
        realm = Realm.builder().realmId(REALM_ID).apiKey("rk_live_test")
                .baseUrl(fs.baseUrl).audience("acme.test").build();
    }

    @AfterEach
    void tearDown() { fs.close(); }

    @Test
    void createSendsScopeAndLabelReturnsOneTimeValue() {
        AtomicReference<Map<String, Object>> seen = new AtomicReference<>();
        fs.on("POST /platforms/" + REALM_ID + "/api-keys", (ex, body) -> {
            seen.set(fs.last().bodyAsMap());
            return FakeServer.Reply.json(201, Map.of(
                    "id", "key_1", "prefix", "rk_live_abc", "role", "admin",
                    "label", "ci-runner", "value", "rk_live_abcSECRET",
                    "created_at", 1_700_000_000L));
        });
        APIKey k = realm.apiKeys().create(APIKeyCreate.of("admin", "ci-runner"));
        assertEquals("admin", seen.get().get("scope"));
        assertEquals("ci-runner", seen.get().get("label"));
        assertEquals("rk_live_abcSECRET", k.value());
        assertEquals("admin", k.role());
        assertEquals("rk_live_abc", k.prefix());
        assertEquals(1_700_000_000L, k.createdAt());
        assertFalse(k.revoked());
    }

    @Test
    void listParsesRoleAndUnixTimestamps() {
        java.util.Map<String, Object> envelope = new java.util.LinkedHashMap<>();
        envelope.put("items", List.of(
                Map.of("id", "k1", "prefix", "rk_live_a", "role", "admin",
                        "created_at", 1_700_000_000L, "last_used_at", 1_700_000_500L),
                Map.of("id", "k2", "prefix", "rk_live_b", "role", "viewer",
                        "created_at", 1_700_000_100L, "revoked_at", 1_700_000_900L)));
        envelope.put("next_cursor", null);
        fs.on("GET /platforms/" + REALM_ID + "/api-keys", (ex, body) -> FakeServer.Reply.json(200, envelope));
        List<APIKey> keys = realm.apiKeys().list();
        assertEquals(2, keys.size());
        APIKey k1 = keys.get(0);
        assertEquals("admin", k1.role());
        assertEquals(1_700_000_500L, k1.lastUsedAt());
        assertNull(k1.revokedAt());
        assertFalse(k1.revoked());
        // No secret on list rows.
        assertNull(k1.value());
        APIKey k2 = keys.get(1);
        assertEquals(1_700_000_900L, k2.revokedAt());
        assertTrue(k2.revoked());
    }

    @Test
    void revokeIssuesDelete() {
        AtomicReference<String> method = new AtomicReference<>();
        fs.on("DELETE /platforms/" + REALM_ID + "/api-keys/k1", (ex, body) -> {
            method.set(fs.last().method);
            return FakeServer.Reply.json(200, Map.of("status", "ok"));
        });
        realm.apiKeys().revoke("k1");
        assertEquals("DELETE", method.get());
    }
}
