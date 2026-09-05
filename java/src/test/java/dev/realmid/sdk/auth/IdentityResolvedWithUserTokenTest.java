package dev.realmid.sdk.auth;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

/**
 * {@code Realm.withUserToken} builds a DERIVED {@code Realm} via a second,
 * copying constructor ({@code Realm.java:184-185}, re-wiring {@code AuthClient}
 * at {@code :194}). The existing doc comment on {@code productRoles} names the
 * exact failure mode: "a withUserToken copy that dropped it would silently
 * stop minting the claim on exactly the BFF lane the claim exists for."
 *
 * <p>This is that test for {@code onIdentityResolved}: it fails — with NO
 * compile error and no exception, only a silently-never-fired hook — the
 * instant someone wires the field into the FIRST {@code Realm} constructor
 * (and the primary-realm test would go green) but forgets the SECOND.
 */
class IdentityResolvedWithUserTokenTest {

    private FakeServer fs;

    private static final Map<String, Object> SESSION = Map.of(
            "access_token", "at-bff",
            "refresh_token", "rtok",
            "user", Map.of("id", "u1"),
            "tenants", List.of(Map.of("tenant_id", "t1", "role", "owner")));

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        fs.onJson("POST /auth/login", (body, rec) -> FakeServer.Reply.json(200, SESSION));
        fs.onJson("POST /auth/token", (body, rec) -> FakeServer.Reply.json(200, Map.of(
                "access_token", "minted", "refresh_token", "rtok2",
                "expires_in", 900, "subject_type", "user",
                "tenant_id", "t1", "role", "owner")));
    }

    @AfterEach
    void tearDown() { fs.close(); }

    @Test
    void firesOnTheDerivedRealmTheBffActuallyUses() {
        AtomicInteger fired = new AtomicInteger();

        Realm parent = Realm.builder().realmId("01HREALM").apiKey("rk_live_test")
                .baseUrl(fs.baseUrl).audience("acme.test")
                .onIdentityResolved(ev -> fired.incrementAndGet())
                .build();

        // The BFF lane: every request goes through a DERIVED realm carrying the
        // caller's own verified access JWT, never through `parent` directly.
        Realm asUser = parent.withUserToken("some-verified-jwt");

        asUser.auth().login(new LoginRequest("google", "provider-token", null, null, null));

        assertFalse(fired.get() == 0,
                "onIdentityResolved never fired on the withUserToken-derived realm — "
                        + "the copy constructor dropped the handler on exactly the "
                        + "BFF lane this hook exists for");
        assertEquals(1, fired.get());
    }
}
