package dev.realmid.sdk.stats;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.info.RealmConfigResponse;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.http.HttpClient;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ConfigAndStatsClientTest {
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
    void configGetReturnsIdAndLooseMap() {
        Map<String, Object> cfg = new LinkedHashMap<>();
        cfg.put("idle_ttl_seconds", 900);
        cfg.put("mfa_policy", "enforced");
        cfg.put("require_bff_login", true);
        cfg.put("origin_enforcement", "");
        cfg.put("access_token_custom_claim_keys", List.of());
        cfg.put("refresh_absolute_expiry", Map.of(
                "mode", "rolling", "daily_cutoff_local", "", "timezone", "", "applies_to_service", false));
        fs.on("GET /platforms/01HREALM/config", (ex, body) ->
                FakeServer.Reply.json(200, Map.of("id", "01HREALM", "config", cfg)));

        RealmConfigResponse out = realm.config().get();
        assertEquals("01HREALM", out.id());
        assertEquals(6, out.config().size());
        assertEquals(900, out.config().get("idle_ttl_seconds"));
        assertEquals("enforced", out.config().get("mfa_policy"));
        assertEquals(Boolean.TRUE, out.config().get("require_bff_login"));
        // Zero values mean "unset" and must survive as keys, not be dropped.
        assertTrue(out.config().containsKey("origin_enforcement"));
        assertEquals("", out.config().get("origin_enforcement"));
        assertEquals(List.of(), out.config().get("access_token_custom_claim_keys"));
        assertEquals(Map.of("mode", "rolling", "daily_cutoff_local", "", "timezone", "", "applies_to_service", false),
                out.config().get("refresh_absolute_expiry"));
    }

    @Test
    void configGetToleratesBareEnvelope() {
        fs.on("GET /platforms/01HREALM/config", (ex, body) ->
                FakeServer.Reply.json(200, Map.of("id", "01HREALM")));
        RealmConfigResponse out = realm.config().get();
        assertNotNull(out.config());
        assertTrue(out.config().isEmpty());
    }

    @Test
    void statsGetDecodesRollup() {
        fs.on("GET /platforms/01HREALM/stats", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                "platform_id", "01HREALM",
                "generated_at", 1783400000L,
                "orgs_count", 7,
                "users_count", 40,
                "sessions_24h", 12,
                "mfa_coverage", Map.of("covered_users", 8, "eligible_users", 40, "percent", 20.0))));

        PlatformStats out = realm.stats().get();
        assertEquals("01HREALM", out.platformId());
        assertEquals(1783400000L, out.generatedAt());
        assertEquals(7, out.orgsCount());
        assertEquals(40, out.usersCount());
        assertEquals(12, out.sessions24h());
        assertEquals(8, out.mfaCoverage().coveredUsers());
        assertEquals(40, out.mfaCoverage().eligibleUsers());
        assertEquals(20.0, out.mfaCoverage().percent());
    }

    @Test
    void statsNullPercentDecodesAsNullNotZero() {
        Map<String, Object> coverage = new LinkedHashMap<>();
        coverage.put("covered_users", 0);
        coverage.put("eligible_users", 0);
        coverage.put("percent", null);
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("platform_id", "01HREALM");
        payload.put("generated_at", 1L);
        payload.put("orgs_count", 0);
        payload.put("users_count", 0);
        payload.put("sessions_24h", 0);
        payload.put("mfa_coverage", coverage);
        fs.on("GET /platforms/01HREALM/stats", (ex, body) -> FakeServer.Reply.json(200, payload));

        PlatformStats out = realm.stats().get();
        assertNull(out.mfaCoverage().percent(),
                "percent must stay null for an empty eligible population");
    }
}
