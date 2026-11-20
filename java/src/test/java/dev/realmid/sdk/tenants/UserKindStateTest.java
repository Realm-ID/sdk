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

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class UserKindStateTest {
    private FakeServer fs;
    private Realm realm;

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        fs.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("access_token", "pt", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform")));
        realm = Realm.builder().sessionStore(new dev.realmid.sdk.session.MemorySessionStore())
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
    void listDecodesKindAndVerifiedEmailState() {
        fs.on("GET /tenants/t1/users", (ex, body) -> {
            java.util.Map<String, Object> page = new java.util.LinkedHashMap<>();
            page.put("items", List.of(
                    Map.of("id", "u1", "kind", "human", "verified_email_state", "unverified_required"),
                    Map.of("id", "u2")));
            page.put("next_cursor", null);
            return FakeServer.Reply.json(200, page);
        });
        List<User> users = realm.tenants().users().list("t1", UserListOpts.empty()).stream().toList();
        assertEquals("human", users.get(0).kind());
        assertEquals("unverified_required", users.get(0).verifiedEmailState());
        assertNull(users.get(1).kind());
        assertNull(users.get(1).verifiedEmailState());
    }

    @Test
    void nineArgumentConstructorStillBuildsAUser() {
        User u = new User("u1", "a@b.test", null, "A", "active", true, "member", "invitation", null);
        assertEquals("u1", u.id());
        assertEquals("invitation", u.joinedVia());
        assertNull(u.kind());
        assertNull(u.verifiedEmailState());
    }
}
