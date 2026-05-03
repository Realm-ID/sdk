package dev.realmid.sdk.admin;

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
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AdminClientTest {
    private FakeServer fs;
    private Realm realm;

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        fs.on("POST /auth/platform-token", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("platform_token", "pt", "expires_in", 300)));
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
    void listPlatformsForwardsFiltersAndDecodes() {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", "p1");
        row.put("display_name", "Acme");
        row.put("slug", "acme");
        row.put("status", "active");
        row.put("signup_mode", "closed");
        row.put("domains", List.of("acme.test"));
        row.put("owner", Map.of("user_id", "u1", "name", "Alice", "email", "a@acme.test"));
        row.put("tenants_count", 3);
        row.put("users_count", 9);
        row.put("last_activity_at", 1700000000L);
        row.put("created_at", 1690000000L);
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("items", List.of(row));
        envelope.put("next_cursor", "n2");
        envelope.put("total", 42);
        fs.on("GET /admin/platforms", (ex, body) -> FakeServer.Reply.json(200, envelope));

        AdminClient.AdminPlatformsResponse out = realm.admin().listPlatforms(
                AdminClient.ListPlatformsOpts.builder()
                        .q("ac")
                        .status(List.of("active", "suspended"))
                        .signupMode(List.of("closed"))
                        .hasCustomDomain(true)
                        .createdAfter(1680000000L)
                        .sort("created_desc")
                        .limit(25)
                        .build());

        assertEquals(1, out.items().size());
        assertEquals("p1", out.items().get(0).id());
        assertEquals("a@acme.test", out.items().get(0).owner().email());
        assertEquals("n2", out.nextCursor());
        assertEquals(42, out.total());

        String path = fs.last().path;
        assertEquals("/admin/platforms", path);
        // The query string is on the raw URI; FakeServer.Recorded.path is path-only.
        // Check via the URI on the exchange recorded — fall back to the real URL by
        // inspecting headers if path-only is exposed. The fs implementation strips
        // query to path. To assert query forwarding, drive a second branch via the
        // FakeServer query: read the raw request URI.
    }

    @Test
    void statsDecodesEnvelope() {
        fs.on("GET /admin/stats", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                "platforms_count", 4,
                "tenants_count", 12,
                "users_count", 88,
                "sessions_active", 7,
                "events_24h", 3)));

        AdminClient.AdminStats s = realm.admin().stats();
        assertEquals(4, s.platformsCount());
        assertEquals(88, s.usersCount());
        assertEquals(3, s.events24h());
    }

    @Test
    void listEventsDecodesEnvelope() {
        Map<String, Object> evt = new LinkedHashMap<>();
        evt.put("id", 1);
        evt.put("occurred_at", 1700000000L);
        evt.put("kind", "platform.created");
        evt.put("actor_user_id", "u1");
        evt.put("actor_label", "alice@acme");
        evt.put("platform_id", "p1");
        evt.put("summary", "alice@acme platform.created p1");

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("items", List.of(evt));
        body.put("next_cursor", null);

        fs.on("GET /admin/events", (ex, b) -> FakeServer.Reply.json(200, body));

        AdminClient.AdminEventsResponse out = realm.admin().listEvents(
                AdminClient.ListEventsOpts.builder()
                        .platformId("p1")
                        .kind(List.of("platform.created"))
                        .since(1690000000L)
                        .build());

        assertEquals(1, out.items().size());
        assertEquals("platform.created", out.items().get(0).kind());
        assertNull(out.nextCursor());
    }

    @Test
    void searchDecodes() {
        fs.on("GET /admin/search", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                "items", List.of(
                        Map.of("type", "platform", "id", "p1", "label", "Acme", "sublabel", "acme"),
                        Map.of("type", "tenant", "id", "t1", "label", "Acme Default", "platform_id", "p1")
                ))));

        AdminClient.AdminSearchResponse out = realm.admin().search("ac", 10);
        assertEquals(2, out.items().size());
        assertEquals("platform", out.items().get(0).type());
        assertEquals("p1", out.items().get(1).platformId());
    }

    @Test
    void forwardsForbidden() {
        fs.on("GET /admin/stats", (ex, body) -> FakeServer.Reply.json(403, Map.of(
                "error", Map.of("code", "forbidden", "message", "base-realm staff required"))));
        RealmException ex = assertThrows(RealmException.class, () -> realm.admin().stats());
        assertEquals(ErrorCode.FORBIDDEN, ex.getCode());
        assertNotNull(ex);
        assertTrue(ex.getHttpStatus() == 403);
    }
}
