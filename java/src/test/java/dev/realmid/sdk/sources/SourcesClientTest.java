package dev.realmid.sdk.sources;

import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.http.HttpClient;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import dev.realmid.sdk.pagination.Page;
import dev.realmid.sdk.pagination.PageOpts;

class SourcesClientTest {
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
    void listGetsSourcesScopedToRealmAndUnwrapsItems() {
        fs.on("GET /sources", (ex, body) -> {
            assertTrue(fs.last().path.contains("platform_id=01HREALM")
                    || rawQueryHas(ex, "platform_id"), "platform_id query expected");
            return FakeServer.Reply.json(200, Map.of(
                    "items", List.of(
                            Map.of("id", "src-1", "platform_id", "01HREALM", "type", "web",
                                    "label", "Web app", "allowed_methods", List.of("google"),
                                    "enabled", true, "created_at", 100),
                            Map.of("id", "src-2", "platform_id", "01HREALM", "type", "bot",
                                    "label", "Bot", "allowed_methods", List.of("otp"),
                                    "enabled", false, "created_at", 200))));
        });
        Page<Source> page = realm.sources().list().page(PageOpts.empty());
        List<Source> items = page.items();
        assertEquals(2, items.size());
        assertEquals(List.of("otp"), items.get(1).allowedMethods());
        assertFalse(items.get(1).enabled());
        // No has_more and no cursor on the wire: not "more pages", not a guess.
        assertFalse(page.hasMore());
    }

    @Test
    void createDefaultsPlatformIdToRealm() {
        fs.onJson("POST /sources", (body, rec) -> {
            assertEquals("01HREALM", body.get("platform_id"));
            assertEquals("web", body.get("type"));
            assertEquals("Web app", body.get("label"));
            assertEquals(List.of("google"), body.get("allowed_methods"));
            return FakeServer.Reply.json(201, Map.of(
                    "id", "src-1", "platform_id", "01HREALM", "type", "web",
                    "label", "Web app", "allowed_methods", List.of("google"),
                    "enabled", true, "created_at", 100));
        });
        Source src = realm.sources().create(new SourceCreate("web", "Web app", List.of("google")));
        assertEquals("src-1", src.id());
        assertEquals("01HREALM", src.platformId());
    }

    @Test
    void createMethodViolatesKindMapsErrorCode() {
        fs.on("POST /sources", (ex, body) -> FakeServer.Reply.json(400, Map.of(
                "error", Map.of("code", "method_violates_kind", "message", "human source may not list otp"))));
        RealmException ex = assertThrows(RealmException.class, () ->
                realm.sources().create(new SourceCreate("web", "X", List.of("otp"))));
        assertEquals(ErrorCode.METHOD_VIOLATES_KIND, ex.getCode());
    }

    @Test
    void updatePatchesOnlyProvidedFields() {
        fs.onJson("PATCH /sources/src-1", (body, rec) -> {
            assertEquals("Renamed", body.get("label"));
            assertEquals(false, body.get("enabled"));
            assertFalse(body.containsKey("allowed_methods"), "allowed_methods should be omitted");
            return FakeServer.Reply.json(200, Map.of(
                    "id", "src-1", "platform_id", "01HREALM", "type", "web",
                    "label", "Renamed", "allowed_methods", List.of("google"),
                    "enabled", false, "created_at", 100));
        });
        Source src = realm.sources().update("src-1", new SourcePatch("Renamed", null, false));
        assertEquals("Renamed", src.label());
        assertFalse(src.enabled());
    }

    @Test
    void deleteHitsRoute() {
        fs.on("DELETE /sources/src-1", (ex, body) -> FakeServer.Reply.json(200, Map.of("status", "deleted")));
        realm.sources().delete("src-1");
        assertEquals("DELETE", fs.last().method);
        assertEquals("/sources/src-1", fs.last().path);
    }

    private static boolean rawQueryHas(com.sun.net.httpserver.HttpExchange ex, String key) {
        String q = ex.getRequestURI().getQuery();
        return q != null && q.contains(key);
    }
}
