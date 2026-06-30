package dev.realmid.sdk.idp;

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

class IdentityProviderConfigClientTest {
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
    void listInjectsPlatformIdAndNormalizesItems() {
        fs.on("GET /identity-providers", (ex, body) -> {
            // platform_id auto-injected = realmId.
            assertTrue(ex.getRequestURI().getQuery().contains("platform_id=01HREALM"));
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", "idp-1");
            row.put("entity_type", "realm");
            row.put("entity_id", "01HREALM");
            row.put("provider", "google");
            row.put("client_type", "web");
            row.put("client_id", "g-123");
            row.put("allowed_origins", List.of("https://acme.test"));
            row.put("comments", "prod");
            row.put("enabled", true);
            row.put("created_at", 1);
            row.put("updated_at", 2);
            return FakeServer.Reply.json(200, Map.of("items", List.of(row)));
        });
        IdpConfigListPage page = realm.identityProviderConfig().list();
        assertEquals(1, page.items().size());
        IdpConfig c = page.items().get(0);
        assertEquals("google", c.provider());
        assertEquals("web", c.clientType());
        assertEquals(List.of("https://acme.test"), c.allowedOrigins());
        assertTrue(c.enabled());
    }

    @Test
    void listAbsentItemsBecomesEmpty() {
        fs.on("GET /identity-providers", (ex, body) -> FakeServer.Reply.json(200, Map.of()));
        IdpConfigListPage page = realm.identityProviderConfig().list();
        assertTrue(page.items().isEmpty());
    }

    @Test
    void listForTenantAddsTenantId() {
        fs.on("GET /identity-providers", (ex, body) -> {
            String q = ex.getRequestURI().getQuery();
            assertTrue(q.contains("platform_id=01HREALM"));
            assertTrue(q.contains("tenant_id=t-9"));
            return FakeServer.Reply.json(200, Map.of("items", List.of()));
        });
        realm.identityProviderConfig().list(IdpConfigListOpts.forTenant("t-9"));
    }

    @Test
    void createInjectsPlatformIdAndMapsWire() {
        fs.onJson("POST /identity-providers", (body, rec) -> {
            assertEquals("01HREALM", body.get("platform_id"));
            assertEquals("google", body.get("provider"));
            assertEquals("web", body.get("client_type"));
            assertEquals("g-123", body.get("client_id"));
            assertEquals(List.of("https://acme.test"), body.get("allowed_origins"));
            assertFalse(body.containsKey("tenant_id"), "tenant_id omitted when null");
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", "idp-1");
            row.put("entity_type", "realm");
            row.put("entity_id", "01HREALM");
            row.put("provider", "google");
            row.put("client_type", "web");
            row.put("client_id", "g-123");
            row.put("allowed_origins", List.of("https://acme.test"));
            row.put("enabled", true);
            row.put("created_at", 1);
            row.put("updated_at", 1);
            return FakeServer.Reply.json(201, row);
        });
        IdpConfig c = realm.identityProviderConfig().create(new IdpConfigCreate(
                null, "google", "web", "g-123", List.of("https://acme.test"), null));
        assertEquals("idp-1", c.id());
        assertEquals("realm", c.entityType());
    }

    @Test
    void createProviderExistsSurfacesConflict() {
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("error", Map.of("code", "conflict", "message", "provider already configured"));
        envelope.put("code", "provider_exists");
        fs.on("POST /identity-providers", (ex, body) -> FakeServer.Reply.json(409, envelope));
        RealmException ex = assertThrows(RealmException.class,
                () -> realm.identityProviderConfig().create(IdpConfigCreate.of("google", "ios", "g-123")));
        assertEquals(ErrorCode.CONFLICT, ex.getCode());
        assertEquals(409, ex.getHttpStatus());
        assertEquals("provider_exists", ex.getDetails().get("code"));
    }

    @Test
    void updateSendsOnlyProvidedFields() {
        fs.onJson("PATCH /identity-providers/idp-1", (body, rec) -> {
            assertTrue(body.containsKey("enabled"));
            assertEquals(Boolean.FALSE, body.get("enabled"));
            assertFalse(body.containsKey("client_id"), "client_id omitted");
            assertFalse(body.containsKey("allowed_origins"), "allowed_origins omitted");
            return FakeServer.Reply.json(200, Map.of(
                    "id", "idp-1", "entity_type", "realm", "entity_id", "01HREALM",
                    "provider", "google", "client_type", "web", "client_id", "g-123",
                    "enabled", false, "created_at", 1, "updated_at", 3));
        });
        IdpConfig c = realm.identityProviderConfig().update("idp-1", IdpConfigPatch.onlyEnabled(false));
        assertFalse(c.enabled());
    }

    @Test
    @SuppressWarnings("unchecked")
    void createAndPatchSendProviderConfig() {
        Map<String, String> fb = Map.of(
                "apiKey", "AIza-test",
                "authDomain", "demo-app.firebaseapp.com",
                "projectId", "demo-app");

        // create includes config and parses it back
        fs.onJson("POST /identity-providers", (body, rec) -> {
            assertEquals(fb, body.get("config"));
            return FakeServer.Reply.json(201, Map.of(
                    "id", "idp-1", "entity_type", "realm", "entity_id", "01HREALM",
                    "provider", "firebase", "client_type", "web", "client_id", "demo-app",
                    "config", fb, "enabled", true, "created_at", 1, "updated_at", 1));
        });
        IdpConfig c = realm.identityProviderConfig().create(new IdpConfigCreate(
                null, "firebase", "web", "demo-app", List.of("https://app.example.com"), null, fb));
        assertEquals("demo-app", c.config().get("projectId"));

        // patch replaces config wholesale
        fs.onJson("PATCH /identity-providers/idp-1", (body, rec) -> {
            assertEquals(fb, body.get("config"));
            assertFalse(body.containsKey("enabled"), "enabled omitted");
            return FakeServer.Reply.json(200, Map.of(
                    "id", "idp-1", "entity_type", "realm", "entity_id", "01HREALM",
                    "provider", "firebase", "client_type", "web", "client_id", "demo-app",
                    "config", fb, "enabled", true, "created_at", 1, "updated_at", 9));
        });
        IdpConfig u = realm.identityProviderConfig().update("idp-1", IdpConfigPatch.onlyConfig(fb));
        assertEquals("demo-app.firebaseapp.com", u.config().get("authDomain"));
    }

    @Test
    void deleteHappy() {
        fs.on("DELETE /identity-providers/idp-1", (ex, body) ->
                FakeServer.Reply.json(200, Map.of("status", "deleted")));
        IdpConfigDeleteResult out = realm.identityProviderConfig().delete("idp-1");
        assertEquals("deleted", out.status());
    }

    @Test
    void deleteNotFoundSurfaces() {
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("error", Map.of("code", "not_found", "message", "no such provider"));
        envelope.put("code", "provider_not_found");
        fs.on("DELETE /identity-providers/idp-missing", (ex, body) ->
                FakeServer.Reply.json(404, envelope));
        RealmException ex = assertThrows(RealmException.class,
                () -> realm.identityProviderConfig().delete("idp-missing"));
        assertEquals(404, ex.getHttpStatus());
        assertEquals("provider_not_found", ex.getDetails().get("code"));
    }
}
