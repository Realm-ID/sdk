package dev.realmid.sdk.serviceaccounts;

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
import java.util.concurrent.ConcurrentHashMap;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ServiceAccountsClientTest {
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
    void createPostsTenantRouteAndMapsDisplayName() {
        fs.onJson("POST /tenants/t1/service-accounts", (body, rec) -> {
            assertEquals("bot@acme.test", body.get("handle"));
            assertEquals("member", body.get("role"));
            assertEquals("Bot", body.get("display_name"));
            // Platform token is auto-attached, like the Roles client.
            assertEquals("Bearer pt", rec.header("authorization"));
            return FakeServer.Reply.json(201, Map.of(
                    "id", "sa-1", "handle", "bot@acme.test", "role", "member",
                    "status", "active", "kind", "service"));
        });
        ServiceAccount sa = realm.serviceAccounts().create("t1",
                new ServiceAccountCreate("bot@acme.test", "member", "Bot"));
        assertEquals("sa-1", sa.id());
        assertEquals("service", sa.kind());
    }

    @Test
    void createHandleTakenMapsErrorCode() {
        fs.on("POST /tenants/t1/service-accounts", (ex, body) -> FakeServer.Reply.json(409, Map.of(
                "error", Map.of("code", "handle_taken", "message", "handle already in use"))));
        RealmException ex = assertThrows(RealmException.class, () ->
                realm.serviceAccounts().create("t1", new ServiceAccountCreate("x@y.z")));
        assertEquals(ErrorCode.HANDLE_TAKEN, ex.getCode());
        assertEquals(409, ex.getHttpStatus());
    }

    @Test
    void createInvalidRoleMapsErrorCode() {
        fs.on("POST /tenants/t1/service-accounts", (ex, body) -> FakeServer.Reply.json(400, Map.of(
                "error", Map.of("code", "invalid_role", "message", "role may not be owner"))));
        RealmException ex = assertThrows(RealmException.class, () ->
                realm.serviceAccounts().create("t1", new ServiceAccountCreate("x@y.z", "owner")));
        assertEquals(ErrorCode.INVALID_ROLE, ex.getCode());
    }

    @Test
    void listUnwrapsItems() {
        fs.on("GET /tenants/t1/service-accounts", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                "items", List.of(
                        Map.of("id", "sa-1", "handle", "a@x.test", "role", "member",
                                "status", "active", "kind", "service"),
                        Map.of("id", "sa-2", "handle", "b@x.test", "role", "member",
                                "status", "suspended", "kind", "service")))));
        List<ServiceAccount> items = realm.serviceAccounts().list("t1");
        assertEquals(2, items.size());
        assertEquals("suspended", items.get(1).status());
    }

    @Test
    void getReturnsAccount() {
        fs.on("GET /tenants/t1/service-accounts/sa-1", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                "id", "sa-1", "handle", "a@x.test", "role", "member",
                "status", "active", "kind", "service")));
        ServiceAccount sa = realm.serviceAccounts().get("t1", "sa-1");
        assertEquals("sa-1", sa.id());
    }

    @Test
    void lifecycleVerbsHitTheRightRoutes() {
        java.util.Set<String> seen = ConcurrentHashMap.newKeySet();
        java.util.function.BiFunction<com.sun.net.httpserver.HttpExchange, byte[], FakeServer.Reply> h =
                (ex, body) -> {
                    seen.add(fs.last().method + " " + fs.last().path);
                    return FakeServer.Reply.json(200, Map.of("id", "sa-1", "kind", "service", "status", "active"));
                };
        fs.on("POST /tenants/t1/service-accounts/sa-1/suspend", h);
        fs.on("POST /tenants/t1/service-accounts/sa-1/unsuspend", h);
        fs.on("POST /tenants/t1/service-accounts/sa-1/deactivate", h);
        fs.on("POST /tenants/t1/service-accounts/sa-1/reset-handle", h);
        fs.on("POST /tenants/t1/service-accounts/sa-1/revoke", (ex, body) -> {
            seen.add(fs.last().method + " " + fs.last().path);
            return FakeServer.Reply.json(200, Map.of("status", "ok", "revoked_sessions", 2));
        });

        realm.serviceAccounts().suspend("t1", "sa-1");
        realm.serviceAccounts().unsuspend("t1", "sa-1");
        realm.serviceAccounts().deactivate("t1", "sa-1");
        realm.serviceAccounts().resetHandle("t1", "sa-1", "new@acme.test");
        ServiceAccountRevokeResult rev = realm.serviceAccounts().revoke("t1", "sa-1");
        assertEquals(2, rev.revokedSessions());

        for (String want : List.of(
                "POST /tenants/t1/service-accounts/sa-1/suspend",
                "POST /tenants/t1/service-accounts/sa-1/unsuspend",
                "POST /tenants/t1/service-accounts/sa-1/deactivate",
                "POST /tenants/t1/service-accounts/sa-1/reset-handle",
                "POST /tenants/t1/service-accounts/sa-1/revoke")) {
            assertTrue(seen.contains(want), "missing call: " + want);
        }
    }

    @Test
    void resetHandleSendsHandle() {
        fs.onJson("POST /tenants/t1/service-accounts/sa-1/reset-handle", (body, rec) -> {
            assertEquals("new@acme.test", body.get("handle"));
            return FakeServer.Reply.json(200, Map.of(
                    "id", "sa-1", "handle", "new@acme.test", "kind", "service"));
        });
        ServiceAccount sa = realm.serviceAccounts().resetHandle("t1", "sa-1", "new@acme.test");
        assertEquals("new@acme.test", sa.handle());
    }
}
