package dev.realmid.sdk.signingkeys;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.http.HttpClient;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SigningKeysClientTest {
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
    void listReadsKeyringAndPolicy() {
        fs.on("GET /platforms/01HREALM/signing-keys", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                "keys", List.of(
                        Map.of("kid", "k2", "created_at", 200, "active_until", 900, "retire_at", 1200, "is_current", true),
                        Map.of("kid", "k1", "created_at", 100, "active_until", 200, "retire_at", 500, "is_current", false)),
                "rotation", Map.of("mode", "auto", "interval", "1w", "next_rotation_at", 900))));
        SigningKeysResponse out = realm.signingKeys().list();
        assertEquals(2, out.keys().size());
        assertTrue(out.keys().get(0).isCurrent());
        assertEquals("k2", out.keys().get(0).kid());
        assertEquals("auto", out.rotation().mode());
        assertEquals("1w", out.rotation().interval());
        assertEquals(900L, out.rotation().nextRotationAt());
    }

    @Test
    void rotatePostsAndReturnsKids() {
        fs.on("POST /platforms/01HREALM/signing-keys/rotate", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("kid", "k3", "retired_kids", List.of("k1"))));
        RotateSigningKeyResult out = realm.signingKeys().rotate();
        assertEquals("k3", out.kid());
        assertEquals(List.of("k1"), out.retiredKids());
    }
}
