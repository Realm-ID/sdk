package dev.realmid.sdk.roles;

import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import com.sun.net.httpserver.HttpExchange;
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
    void systemConstants() {
        assertEquals("owner", Role.OWNER);
        assertEquals("member", Role.MEMBER);
    }

    @Test
    void listReturnsLockedEnvelopeShape() {
        fs.on("GET /platforms/01HREALM/roles", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                "items", List.of(
                        Map.of("id", "role-owner", "name", "owner", "permissions", List.of(),
                                "is_system", true, "created_at", 1, "updated_at", 1),
                        Map.of("id", "role-salesman", "name", "salesman", "display_name", "Field Sales",
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
                    "id", "role-salesman",
                    "permissions", List.of("bills:read"),
                    "is_system", false, "created_at", 1, "updated_at", 1));
        });
        RoleObject r = realm.roles().create(new RoleCreate(
                "salesman", "Field Sales", List.of("bills:read")));
        assertEquals("salesman", r.name());
        assertFalse(r.isSystem());
    }

    // createForwardsRequiredMfaMethods is REMOVED (ADR-101): the field no longer
    // exists on either side of the wire. Zero realms ever configured a per-role
    // MFA floor.


    // ADR-081 principal typing: a role field the server shipped for releases
    // without an SDK type, so this pins the round trip in both directions.
    //
    // It used to cover the ADR-076 WP4 invitation scope alongside it; ADR-101
    // retired that field, and the assertion below now checks it is NOT sent — a
    // client still emitting it would have the key silently discarded.
    @Test
    void createForwardsAssignableTo() {
        fs.onJson("POST /platforms/01HREALM/roles", (body, rec) -> {
            assertEquals(List.of("service"), body.get("assignable_to"));
            assertNull(body.get("can_invite_roles"), "ADR-101 retired can_invite_roles");
            assertNull(body.get("required_mfa_methods"), "ADR-101 retired required_mfa_methods");
            return FakeServer.Reply.json(201, Map.of(
                    "name", "bot", "display_name", "Bot", "id", "role-bot",
                    "permissions", List.of(), "assignable_to", List.of("service"),
                    "is_system", false, "created_at", 1, "updated_at", 1));
        });
        RoleObject r = realm.roles().create(new RoleCreate(
                "bot", "Bot", List.of(), List.of("service")));
        assertEquals(List.of("service"), r.assignableTo());
        assertNull(r.migratedHolders(), "migrated_holders is absent unless a narrowing moved holders");
    }

    // A PATCH that narrows assignable_to away from humans migrates the role's
    // existing human holders server-side (ADR-081 s2.5) and reports how many
    // moved, and to where. Boxed Integer so an absent field stays null.
    @Test
    void updateSurfacesHolderMigration() {
        fs.onJson("PATCH /platforms/01HREALM/roles/role-bot", (body, rec) -> {
            assertEquals(List.of("service"), body.get("assignable_to"));
            assertFalse(body.containsKey("permissions"), "permissions should be omitted");
            // 11 entries — past Map.of's 10-pair ceiling, hence the explicit map.
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("id", "role-bot");
            out.put("name", "bot");
            out.put("permissions", List.of());
            out.put("required_mfa_methods", List.of());
            out.put("can_invite_roles", List.of());
            out.put("assignable_to", List.of("service"));
            out.put("migrated_holders", 12);
            out.put("migrated_holders_to", "member");
            out.put("is_system", false);
            out.put("created_at", 1);
            out.put("updated_at", 2);
            return FakeServer.Reply.json(200, out);
        });
        RoleObject r = realm.roles().update("role-bot", RolePatch.onlyAssignableTo(List.of("service")));
        assertEquals(Integer.valueOf(12), r.migratedHolders());
        assertEquals("member", r.migratedHoldersTo());
    }

    @Test
    void updateSendsOnlyProvidedFields() {
        fs.onJson("PATCH /platforms/01HREALM/roles/role-salesman", (body, rec) -> {
            assertFalse(body.containsKey("display_name"), "display_name should be omitted");
            assertNotNull(body.get("permissions"));
            return FakeServer.Reply.json(200, Map.of(
                    "name", "salesman",
                    "id", "role-salesman",
                    "permissions", List.of("bills:read", "orders:all"),
                    "is_system", false, "created_at", 1, "updated_at", 2));
        });
        RoleObject r = realm.roles().update("role-salesman",
                RolePatch.onlyPermissions(List.of("bills:read", "orders:all")));
        assertEquals(2, r.permissions().size());
    }

    @Test
    void deleteHappy() {
        fs.on("DELETE /platforms/01HREALM/roles/role-old", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("status", "deleted")));
        RoleDeleteResult out = realm.roles().delete("role-old");
        assertEquals("deleted", out.status());
    }

    @Test
    void delete409SurfacesConflict() {
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("error", Map.of("code", "conflict", "message", "role still attached to users"));
        envelope.put("code", "role_in_use");
        envelope.put("role_in_use", true);
        fs.on("DELETE /platforms/01HREALM/roles/role-salesman", (ex, body) ->
                FakeServer.Reply.json(409, envelope));

        RealmException ex = assertThrows(RealmException.class, () -> realm.roles().delete("role-salesman"));
        assertEquals(ErrorCode.CONFLICT, ex.getCode());
        assertEquals(409, ex.getHttpStatus());
        // The server's role-specific code rides through on details siblings.
        Object roleInUse = ex.getDetails().get("role_in_use");
        assertTrue(roleInUse instanceof Boolean && (Boolean) roleInUse);
    }

    @Test
    void renamePostsTo() {
        fs.onJson("POST /platforms/01HREALM/roles/role-oldname/rename", (body, rec) -> {
            assertEquals("newname", body.get("to"));
            return FakeServer.Reply.json(200, Map.of(
                    "name", "newname", "permissions", List.of(),
                    "id", "role-oldname",
                    "is_system", false, "created_at", 1, "updated_at", 2));
        });
        RoleObject r = realm.roles().rename("role-oldname", "newname");
        assertEquals("newname", r.name());
    }

    @Test
    void listForwardsIncludeSystem() {
        fs.on("GET /platforms/01HREALM/roles", (HttpExchange ex, byte[] body) -> {
            String q = ex.getRequestURI().getRawQuery();
            assertNotNull(q);
            assertTrue(q.contains("include_system=true"), "query=" + q);
            return FakeServer.Reply.json(200, Map.of("items", List.of()));
        });
        realm.roles().list(RoleListOpts.includingSystem());
    }

    @Test
    void disablePostsAndDecodesDisabledFields() {
        fs.on("POST /platforms/01HREALM/roles/role-x/disable", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                "id", "role-x", "name", "salesman", "permissions", List.of(),
                "is_system", false, "disabled", true, "disabled_at", 42,
                "created_at", 1, "updated_at", 2)));
        RoleObject r = realm.roles().disable("role-x");
        assertTrue(r.disabled());
        assertEquals(42L, r.disabledAt());
    }

    @Test
    void enablePosts() {
        fs.on("POST /platforms/01HREALM/roles/role-x/enable", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                "id", "role-x", "name", "salesman", "permissions", List.of(),
                "is_system", false, "disabled", false, "created_at", 1, "updated_at", 3)));
        RoleObject r = realm.roles().enable("role-x");
        assertFalse(r.disabled());
    }
}
