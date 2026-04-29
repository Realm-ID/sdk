package dev.realmid.sdk.roles;

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
import static org.junit.jupiter.api.Assertions.assertFalse;

class RolesClientTest {
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
    void systemConstants() {
        assertEquals("owner", Role.OWNER);
        assertEquals("member", Role.MEMBER);
    }

    @Test
    void listReturnsLockedEnvelopeShape() {
        fs.on("GET /platforms/01HREALM/roles", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                "items", List.of(
                        Map.of("name", "owner", "permissions", List.of(),
                                "is_system", true, "created_at", 1, "updated_at", 1),
                        Map.of("name", "salesman", "display_name", "Field Sales",
                                "permissions", List.of("bills:read"),
                                "is_system", false, "created_at", 2, "updated_at", 3)),
                "next_cursor", "",
                "total", 2)));
        RoleListPage page = realm.roles().list();
        assertEquals(2, page.items().size());
        assertEquals("salesman", page.items().get(1).name());
        assertEquals("Field Sales", page.items().get(1).displayName());
        assertNull(page.nextCursor());
        assertEquals(2L, page.total());
    }

    @Test
    void createMapsWireShape() {
        fs.onJson("POST /platforms/01HREALM/roles", (body, rec) -> {
            assertEquals("salesman", body.get("name"));
            assertEquals("Field Sales", body.get("display_name"));
            return FakeServer.Reply.json(201, Map.of(
                    "name", "salesman", "display_name", "Field Sales",
                    "permissions", List.of("bills:read"),
                    "is_system", false, "created_at", 1, "updated_at", 1));
        });
        RoleObject r = realm.roles().create(new RoleCreate(
                "salesman", "Field Sales", List.of("bills:read")));
        assertEquals("salesman", r.name());
        assertFalse(r.isSystem());
    }

    @Test
    void updateSendsOnlyProvidedFields() {
        fs.onJson("PATCH /platforms/01HREALM/roles/salesman", (body, rec) -> {
            assertFalse(body.containsKey("display_name"), "display_name should be omitted");
            assertNotNull(body.get("permissions"));
            return FakeServer.Reply.json(200, Map.of(
                    "name", "salesman",
                    "permissions", List.of("bills:read", "orders:all"),
                    "is_system", false, "created_at", 1, "updated_at", 2));
        });
        RoleObject r = realm.roles().update("salesman",
                RolePatch.onlyPermissions(List.of("bills:read", "orders:all")));
        assertEquals(2, r.permissions().size());
    }

    @Test
    void deleteHappy() {
        fs.on("DELETE /platforms/01HREALM/roles/old", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("status", "deleted")));
        RoleDeleteResult out = realm.roles().delete("old");
        assertEquals("deleted", out.status());
    }

    @Test
    void delete409SurfacesConflict() {
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("error", Map.of("code", "conflict", "message", "role still attached to users"));
        envelope.put("code", "role_in_use");
        envelope.put("role_in_use", true);
        fs.on("DELETE /platforms/01HREALM/roles/salesman", (ex, body) ->
                FakeServer.Reply.json(409, envelope));

        RealmException ex = assertThrows(RealmException.class, () -> realm.roles().delete("salesman"));
        assertEquals(ErrorCode.CONFLICT, ex.getCode());
        assertEquals(409, ex.getHttpStatus());
        // The server's role-specific code rides through on details siblings.
        Object roleInUse = ex.getDetails().get("role_in_use");
        assertTrue(roleInUse instanceof Boolean && (Boolean) roleInUse);
    }

    @Test
    void renamePostsTo() {
        fs.onJson("POST /platforms/01HREALM/roles/oldname/rename", (body, rec) -> {
            assertEquals("newname", body.get("to"));
            return FakeServer.Reply.json(200, Map.of(
                    "name", "newname", "permissions", List.of(),
                    "is_system", false, "created_at", 1, "updated_at", 2));
        });
        RoleObject r = realm.roles().rename("oldname", "newname");
        assertEquals("newname", r.name());
    }
}
