package dev.realmid.sdk.idp;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.http.HttpClient;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class IdentityProvidersClientTest {
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
    void discoverHitsRealmEndpointAndDecodesProviders() {
        AtomicReference<String> query = new AtomicReference<>("");
        AtomicReference<String> origin = new AtomicReference<>(null);
        fs.on("GET /platforms/r-1/identity-providers", (ex, body) -> {
            query.set(ex.getRequestURI().getRawQuery());
            origin.set(ex.getRequestHeaders().getFirst("Origin"));
            return FakeServer.Reply.json(200, Map.of(
                    "tenant_id", "tnt-1",
                    "providers", List.of(
                            Map.of("type", "google", "client_type", "web", "client_id", "goog-123"),
                            Map.of("type", "firebase", "client_type", "web", "client_id", "fb-1",
                                    "config", Map.of("apiKey", "k", "authDomain", "d")))));
        });

        IdentityProvidersResponse res = realm.identityProviders().discover(
                new IdentityProvidersOptions("web", "tnt-1", "https://app.partner.com"));

        assertTrue(query.get().contains("platform=web"), query.get());
        assertTrue(query.get().contains("tenant_id=tnt-1"), query.get());
        assertEquals("https://app.partner.com", origin.get());
        assertEquals("tnt-1", res.tenantId());
        assertEquals(2, res.providers().size());
        assertEquals("google", res.providers().get(0).type());
        assertEquals("k", res.providers().get(1).config().get("apiKey"));
    }
}
