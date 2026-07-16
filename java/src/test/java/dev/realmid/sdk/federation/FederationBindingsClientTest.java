package dev.realmid.sdk.federation;

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
import static org.junit.jupiter.api.Assertions.assertFalse;

class FederationBindingsClientTest {
    private FakeServer fs;
    private Realm realm;

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        fs.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("access_token", "pt", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform")));
        realm = Realm.builder()
                .realmId("r-1")
                .apiKey("rk")
                .baseUrl(fs.baseUrl)
                .audience("acme.test")
                .httpClient(HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build())
                .build();
    }

    @AfterEach
    void tearDown() { fs.close(); }

    @Test
    void listPagesBindings() {
        fs.on("GET /platforms/r-1/federation-bindings", (ex, body) -> {
            java.util.Map<String, Object> page = new java.util.LinkedHashMap<>();
            page.put("items", List.of(Map.of(
                    "id", "fb1", "issuer", "https://token.actions.githubusercontent.com",
                    "status", "active", "match_claims", Map.of("repository", "acme/billing"))));
            page.put("next_cursor", null);
            return FakeServer.Reply.json(200, page);
        });
        List<FederationBinding> all = realm.federationBindings().list().stream().toList();
        assertEquals(1, all.size());
        assertEquals("fb1", all.get(0).id());
        assertEquals("acme/billing", all.get(0).matchClaims().get("repository"));
    }

    @Test
    @SuppressWarnings("unchecked")
    void createPostsSnakeCaseBody() {
        fs.on("POST /platforms/r-1/federation-bindings", (ex, body) -> FakeServer.Reply.json(201, Map.of(
                "id", "fb2", "platform_id", "r-1", "issuer", "https://token.actions.githubusercontent.com",
                "audience", "ri-const", "status", "active", "mapped_role", "platform_api")));
        FederationBinding fb = realm.federationBindings().create(new FederationBindingCreate(
                "https://token.actions.githubusercontent.com",
                Map.of("repository", "acme/billing"), "platform_api", List.of("read")));
        assertEquals("fb2", fb.id());
        assertEquals("ri-const", fb.audience());

        Map<String, Object> sent = fs.last().bodyAsMap();
        assertEquals("https://token.actions.githubusercontent.com", sent.get("issuer"));
        assertEquals(Map.of("repository", "acme/billing"), sent.get("match_claims"));
        assertEquals("platform_api", sent.get("mapped_role"));
        assertEquals(List.of("read"), sent.get("scope"));
    }

    @Test
    void createOmitsNullOptionalFields() {
        fs.on("POST /platforms/r-1/federation-bindings", (ex, body) -> FakeServer.Reply.json(201,
                Map.of("id", "fb3", "issuer", "https://accounts.google.com", "status", "active")));
        realm.federationBindings().create(FederationBindingCreate.of(
                "https://accounts.google.com", Map.of("sub", "12345")));
        Map<String, Object> sent = fs.last().bodyAsMap();
        assertFalse(sent.containsKey("mapped_role"));
        assertFalse(sent.containsKey("scope"));
    }

    @Test
    void revokeDeletesById() {
        fs.on("DELETE /platforms/r-1/federation-bindings/fb2", (ex, body) ->
                FakeServer.Reply.json(200, Map.of("status", "revoked", "id", "fb2")));
        FederationBindingRevokeResult res = realm.federationBindings().revoke("fb2");
        assertEquals("revoked", res.status());
        assertEquals("fb2", res.id());
    }
}
