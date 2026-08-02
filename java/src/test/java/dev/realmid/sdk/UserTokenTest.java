package dev.realmid.sdk;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.http.HttpClient;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * {@code Realm.withUserToken} — the on-behalf-of mode on the TYPED surface
 * (SPEC §4 verified on-behalf-of; ADR-056). {@code MeClientTest} covers the per-call user token on
 * {@code realm.me().*}; these cover the part a partner BFF actually needs,
 * where the header must ride on {@code tenants().list()} and every other typed
 * method with no per-call argument.
 */
class UserTokenTest {
    private FakeServer fs;
    private Realm realm;

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        fs.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("access_token", "pt", "refresh_token", "rt", "expires_in", 300,
                        "subject_type", "platform")));
        // A LinkedHashMap, not Map.of: `next_cursor` is null on the last page
        // and Map.of rejects null values — the NPE would surface as an opaque
        // "header parser received no bytes" instead of a test failure.
        fs.on("GET /tenants", (ex, body) -> {
            java.util.Map<String, Object> page = new java.util.LinkedHashMap<>();
            page.put("items", List.of());
            page.put("next_cursor", null);
            return FakeServer.Reply.json(200, page);
        });
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

    /** All values sent under {@code name}; > 1 means a duplicated header. */
    private List<String> allValues(String name) {
        for (Map.Entry<String, List<String>> e : fs.last().headers.entrySet()) {
            if (e.getKey().equalsIgnoreCase(name)) return e.getValue();
        }
        return List.of();
    }

    @Test
    void typedCallCarriesUserTokenBesideThePlatformBearer() {
        realm.withUserToken("verified-jwt").tenants().list().page(dev.realmid.sdk.pagination.PageOpts.empty());

        assertEquals("/tenants", fs.last().path);
        // Additive, not a replacement: the realm's platform token stays the
        // wire bearer and the verified user JWT names the caller. A bare user
        // id is not an identity (issuer v0.66.0), so this header is the whole
        // assertion.
        assertEquals("Bearer pt", fs.last().header("authorization"));
        assertEquals(List.of("verified-jwt"), allValues("X-User-Token"));
    }

    @Test
    void theParentRealmKeepsNoUserIdentity() {
        realm.withUserToken("verified-jwt").tenants().list().page(dev.realmid.sdk.pagination.PageOpts.empty());
        assertEquals("verified-jwt", fs.last().header("X-User-Token"));

        realm.tenants().list().page(dev.realmid.sdk.pagination.PageOpts.empty());
        // Derivation, not mutation — the long-lived handle must never inherit a
        // request-scoped identity, or one request's user leaks into the next.
        assertNull(fs.last().header("X-User-Token"));
    }

    @Test
    void derivedHandlesDoNotLeakIntoEachOther() {
        Realm a = realm.withUserToken("jwt-a");
        Realm b = a.withUserToken("jwt-b");

        a.tenants().list().page(dev.realmid.sdk.pagination.PageOpts.empty());
        assertEquals("jwt-a", fs.last().header("X-User-Token"));
        b.tenants().list().page(dev.realmid.sdk.pagination.PageOpts.empty());
        assertEquals("jwt-b", fs.last().header("X-User-Token"));
    }

    @Test
    void aPerCallUserTokenOverridesAndNeverDuplicates() {
        fs.on("POST /me/tenant-choice", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("tenant_id", "t1", "status", "chosen", "released", 0)));

        realm.withUserToken("client-jwt").me()
                .chooseTenant("t1", dev.realmid.sdk.me.MeAuth.onBehalfOf("per-call-jwt"));

        // `me` sends the header as "X-User-Token"; the transport sets
        // "x-user-token". Header names are case-INSENSITIVE and
        // HttpRequest.Builder.header() APPENDS, so a naive merge would put both
        // on the wire and the issuer would see a token it cannot parse. Assert
        // on the full value list, not header(), which returns only the first.
        assertEquals(List.of("per-call-jwt"), allValues("X-User-Token"));
    }

    @Test
    void anEmptyTokenIsRefusedRatherThanSilentlyIgnored() {
        // Deriving with nothing would hand back a handle that looks
        // user-scoped and silently calls as the bare platform credential —
        // exactly the confusion v0.66.0 closed on the issuer side.
        assertThrows(RealmException.class, () -> realm.withUserToken(""));
        assertThrows(RealmException.class, () -> realm.withUserToken(null));
    }
}
