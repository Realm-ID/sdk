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
