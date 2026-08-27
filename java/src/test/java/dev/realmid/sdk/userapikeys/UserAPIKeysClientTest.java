package dev.realmid.sdk.userapikeys;

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
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ADR-100 — the write body. There was no test for this client's wire shape
 * before; the forced-choice field is what earns the first one.
 */
class UserAPIKeysClientTest {
    private static final String ROUTE = "/tenants/t1/users/u1/user-api-keys";

    private FakeServer fs;
    private Realm realm;

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        fs.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("access_token", "pt", "refresh_token", "rt", "expires_in", 300,
                        "subject_type", "platform")));
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

    /**
     * FALSE is exactly the value a null guard would drop — the idiom every
     * neighbouring field in this client uses — and dropping it would put the
     * pre-ADR-100 wire shape, a body with no authority statement, back on the
     * wire from inside the SDK that exists to prevent it.
     */
    @Test
    void createAlwaysStatesUncappedIncludingFalse() {
        fs.onJson("POST " + ROUTE, (body, rec) -> {
            assertTrue(body.containsKey("uncapped"),
                    "uncapped absent from the create body — that IS the shape ADR-100 makes illegal");
            assertEquals(Boolean.FALSE, body.get("uncapped"));
            assertEquals(List.of("a"), body.get("permissions_cap"));
            return FakeServer.Reply.json(201, Map.of("id", "k1", "label", "ci"));
        });
        UserAPIKey out = realm.userApiKeys().create("t1", "u1",
                UserAPIKeyWrite.capped("ci", List.of("a")));
        assertEquals("k1", out.id());
    }

    /**
     * The uncapped factory sends a positive TRUE and no cap. Both halves matter:
     * a cap alongside {@code uncapped: true} is self-contradicting and the
     * server refuses it.
     */
    @Test
    void uncappedFactorySendsTrueAndNoCap() {
        fs.onJson("POST " + ROUTE, (body, rec) -> {
            assertEquals(Boolean.TRUE, body.get("uncapped"));
            assertFalse(body.containsKey("permissions_cap"));
            return FakeServer.Reply.json(201, Map.of("id", "k2", "uncapped", true));
        });
        UserAPIKey out = realm.userApiKeys().create("t1", "u1", UserAPIKeyWrite.uncapped("wide"));
        assertEquals(Boolean.TRUE, out.uncapped());
        assertNull(out.permissionsCap());
    }

    /**
     * A null {@code uncapped} travels as JSON null rather than being omitted, so
     * "I did not say" reaches the server and earns a 400 instead of the SDK
     * quietly choosing a default. A caller who forgets fails LOUDLY.
     */
    @Test
    void nullUncappedIsTransmittedNotOmitted() {
        fs.onJson("POST " + ROUTE, (body, rec) -> {
            assertTrue(body.containsKey("uncapped"), "uncapped must be PRESENT and null, not omitted");
            assertNull(body.get("uncapped"));
            return FakeServer.Reply.json(400, Map.of(
                    "error", Map.of("code", "uncapped_required", "message", "state it")));
        });
        UserAPIKeyWrite forgot = new UserAPIKeyWrite("x", null, null, null, null, null);
        try {
            realm.userApiKeys().create("t1", "u1", forgot);
        } catch (RuntimeException expected) {
            // the 400 is the point; the assertions above already ran server-side
        }
    }

    /**
     * D12's one-write-schema rule: update's body is byte-identical to what
     * create would send for the same input, so the pair cannot drift into a
     * PATCH.
     */
    @Test
    void updateIsAPutOfTheSameShape() {
        fs.onJson("PUT " + ROUTE + "/k9", (body, rec) -> {
            assertEquals("ci", body.get("label"));
            assertEquals(Boolean.FALSE, body.get("uncapped"));
            assertEquals(List.of("a"), body.get("permissions_cap"));
            return FakeServer.Reply.json(200, Map.of("id", "k9", "label", "ci"));
        });
        UserAPIKey out = realm.userApiKeys().update("t1", "u1", "k9",
                UserAPIKeyWrite.capped("ci", List.of("a")));
        assertEquals("k9", out.id());
    }
}
