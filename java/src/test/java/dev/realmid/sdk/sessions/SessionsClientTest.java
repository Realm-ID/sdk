package dev.realmid.sdk.sessions;

import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.http.HttpClient;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class SessionsClientTest {
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
    void revokeUserPostsMemberRouteAndParsesResult() {
        fs.onJson("POST /tenants/t1/users/u9/sessions/revoke", (body, rec) -> {
            assertEquals("Bearer pt", rec.header("authorization"));
            return FakeServer.Reply.json(200, Map.of("status", "ok", "revoked", 3));
        });
        SessionRevokeResult r = realm.sessions().revokeUser("t1", "u9");
        assertEquals("ok", r.status());
        assertEquals(3L, r.revoked());
    }

    @Test
    void revokeUserNotFoundSurfaces() {
        fs.on("POST /tenants/t1/users/ghost/sessions/revoke", (ex, body) -> FakeServer.Reply.json(404,
                Map.of("error", Map.of("code", "not_found", "message", "no such user"))));
        RealmException ex = assertThrows(RealmException.class, () -> realm.sessions().revokeUser("t1", "ghost"));
        assertEquals(ErrorCode.NOT_FOUND, ex.getCode());
        assertEquals(404, ex.getHttpStatus());
    }

    @Test
    void revokeAllPostsRealmRouteWithOwnRealmId() {
        fs.onJson("POST /platforms/01HREALM/sessions/revoke-all", (body, rec) -> {
            assertEquals("Bearer pt", rec.header("authorization"));
            return FakeServer.Reply.json(200, Map.of("status", "ok", "revoked", 42));
        });
        SessionRevokeResult r = realm.sessions().revokeAll();
        assertEquals("ok", r.status());
        assertEquals(42L, r.revoked());
    }
}
