package dev.realmid.sdk.tenants;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.http.HttpClient;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;

class TenantsClientTest {
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
    void listPaginatesAcrossTwoPages() {
        AtomicInteger calls = new AtomicInteger();
        fs.on("GET /tenants", (ex, body) -> {
            int n = calls.incrementAndGet();
            if (n == 1) {
                return FakeServer.Reply.json(200, Map.of(
                        "items", List.of(
                                Map.of("id", "t1", "display_name", "T1"),
                                Map.of("id", "t2", "display_name", "T2")),
                        "next_cursor", "cur-2"));
            }
            // Map.of() rejects nulls; use a HashMap so next_cursor=null serializes.
            java.util.Map<String, Object> page = new java.util.LinkedHashMap<>();
            page.put("items", List.of(Map.of("id", "t3", "display_name", "T3")));
            page.put("next_cursor", null);
            return FakeServer.Reply.json(200, page);
        });
        List<Tenant> all = realm.tenants().list().stream().toList();
        assertEquals(3, all.size());
        assertEquals("t1", all.get(0).id());
        assertEquals("t3", all.get(2).id());
        assertEquals(2, calls.get());
    }

    @Test
    void userListThreadsRoleStatusQFilters() {
        java.util.concurrent.atomic.AtomicReference<String> query = new java.util.concurrent.atomic.AtomicReference<>("");
        fs.on("GET /tenants/t1/users", (ex, body) -> {
            query.set(ex.getRequestURI().getRawQuery());
            java.util.Map<String, Object> page = new java.util.LinkedHashMap<>();
            page.put("items", List.of(Map.of("id", "u1")));
            page.put("next_cursor", null);
            return FakeServer.Reply.json(200, page);
        });
        realm.tenants().users().list("t1", new UserListOpts("admin", "active", "acme")).stream().toList();
        String q = query.get();
        org.junit.jupiter.api.Assertions.assertTrue(q.contains("role=admin"), q);
        org.junit.jupiter.api.Assertions.assertTrue(q.contains("status=active"), q);
        org.junit.jupiter.api.Assertions.assertTrue(q.contains("q=acme"), q);
    }

    @Test
    void invitationListThreadsStatusFilter() {
        java.util.concurrent.atomic.AtomicReference<String> query = new java.util.concurrent.atomic.AtomicReference<>("");
        fs.on("GET /tenants/t1/invitations", (ex, body) -> {
            query.set(ex.getRequestURI().getRawQuery());
            java.util.Map<String, Object> page = new java.util.LinkedHashMap<>();
            page.put("items", List.of(Map.of("id", "i1")));
            page.put("next_cursor", null);
            return FakeServer.Reply.json(200, page);
        });
        realm.tenants().invitations().list("t1", InvitationListOpts.withStatus("pending")).stream().toList();
        org.junit.jupiter.api.Assertions.assertTrue(query.get().contains("status=pending"), query.get());
    }

    @Test
    @SuppressWarnings("unchecked")
    void importUsersPostsUsersArrayAndDecodesReport() {
        fs.on("POST /tenants/t1/users/import", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                "committed", true,
                "imported", 2,
                "updated", 0,
                "failed", 0,
                "rows", List.of(
                        Map.of("line", 1, "user_id", "byo-1", "identifier", "a@x.com", "status", "created"),
                        Map.of("line", 2, "user_id", "minted-2", "identifier", "b@x.com", "status", "created")))));

        ImportUsersResult res = realm.tenants().users().importUsers("t1", List.of(
                new ImportUserRow("byo-1", "a@x.com", null, "member", null, null, null, null),
                ImportUserRow.of("b@x.com", "member")));

        assertEquals(true, res.committed());
        assertEquals(2, res.imported());
        assertEquals(2, res.rows().size());
        assertEquals("minted-2", res.rows().get(1).userId());
        assertEquals("created", res.rows().get(1).status());

        Map<String, Object> sent = fs.last().bodyAsMap();
        List<Object> users = (List<Object>) sent.get("users");
        assertEquals(2, users.size());
        Map<String, Object> row0 = (Map<String, Object>) users.get(0);
        assertEquals("byo-1", row0.get("user_id"));
        assertEquals("member", row0.get("role"));
        Map<String, Object> row1 = (Map<String, Object>) users.get(1);
        assertEquals("b@x.com", row1.get("email"));
        // row without user_id must omit the key (bring-your-own optional).
        assertEquals(false, row1.containsKey("user_id"));
    }

    @Test
    void createRoutesToPlatformScopeAndSendsContractBody() {
        // Pins SPEC §6.1 / swagger POST /platforms/{realmId}/tenants: the realm
        // is implicit (the API key's realm, "01HREALM" here). GoFr returns 201.
        fs.on("POST /platforms/01HREALM/tenants", (ex, body) -> FakeServer.Reply.json(201,
                Map.of("id", "t-new", "display_name", "Acme")));

        Tenant t = realm.tenants().create(
                new TenantCreate("byo-id", "Acme", List.of("acme.com"), "allowlist",
                        "2020-01-02T03:04:05Z",
                        new TenantOwner("owner-1", "boss@acme.com", null, "Boss", null, null)));
        assertEquals("t-new", t.id());
        assertEquals("Acme", t.displayName());

        Map<String, Object> b = fs.last().bodyAsMap();
        assertEquals("byo-id", b.get("id"));
        assertEquals("Acme", b.get("display_name"));
        assertEquals(List.of("acme.com"), b.get("allowed_domains"));
        assertEquals("allowlist", b.get("signup_mode"));
        assertEquals("2020-01-02T03:04:05Z", b.get("created_at"));
        // Owner (ADR-073 Amendment C.2) serialized as a nested snake_case object.
        Map<String, Object> owner = (Map<String, Object>) b.get("owner");
        assertEquals("owner-1", owner.get("user_id"));
        assertEquals("boss@acme.com", owner.get("email"));
        assertEquals("Boss", owner.get("display_name"));
        // Divergence guard: the retired create fields must never reappear.
        assertEquals(false, b.containsKey("owner_user_id"));
        assertEquals(false, b.containsKey("config"));
    }

    @Test
    void createOmitsOptionalFieldsWhenNull() {
        fs.on("POST /platforms/01HREALM/tenants", (ex, body) -> FakeServer.Reply.json(201,
                Map.of("id", "t2", "display_name", "Bare")));
        // Owner is mandatory on create (ADR-073 Amendment C); id/domains/mode/
        // created_at stay omitted when null.
        realm.tenants().create(TenantCreate.of("Bare", TenantOwner.ofEmail("boss@bare.com")));
        Map<String, Object> b = fs.last().bodyAsMap();
        assertEquals(Map.of(
                "display_name", "Bare",
                "owner", Map.of("email", "boss@bare.com")), b);
    }

    @Test
    void transferOwnerSendsOwnerPointerAndOptionalKnobs() {
        fs.on("PUT /tenants/t1/owner", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("id", "t1", "owner_user_id", "u-new")));

        // null opts → owner_user_id only.
        Tenant t = realm.tenants().transferOwner("t1", "u-new");
        assertEquals("t1", t.id());
        assertEquals(Map.of("owner_user_id", "u-new"), fs.last().bodyAsMap());

        // opts → both knobs present.
        realm.tenants().transferOwner("t1", "u-new", new TransferOwnerOptions("admin", true));
        Map<String, Object> b = fs.last().bodyAsMap();
        assertEquals("u-new", b.get("owner_user_id"));
        assertEquals("admin", b.get("outgoing_owner_role"));
        assertEquals(true, b.get("leave_entirely"));
    }

    @Test
    void updateUserRoleHitsRoleEndpoint() {
        fs.on("PATCH /tenants/t1/users/u9/role", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("id", "u9", "role", "admin", "tenant_id", "t1", "updated_at", 1730000000L)));
        UpdateUserRoleResult res = realm.tenants().updateUserRole("t1", "u9", "admin");
        assertEquals("u9", res.id());
        assertEquals("admin", res.role());
        assertEquals("t1", res.tenantId());
        assertEquals(1730000000L, res.updatedAt());
        assertEquals(Map.of("role", "admin"), fs.last().bodyAsMap());
    }
}
