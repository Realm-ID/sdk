package dev.realmid.sdk.auth;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * The LOGIN half of the derived-claims seam.
 *
 * <p>This file is the MIRROR of {@code DerivedClaimsRefreshTest}, and it exists
 * for the reason that test's header gives: a {@code scopes} handler that worked
 * on refresh but not on login would reproduce the exact defect being fixed,
 * pointed the other way — and it would be found the same way, by a partner, in
 * production.
 *
 * <p>{@code mintProductRoles} is the shared login-lane mint ({@code login} and
 * {@code completeLogin}), so proving it here proves both.
 */
class DerivedClaimsLoginTest {

    private FakeServer fs;
    private AtomicReference<Map<String, Object>> mintBody;
    private AtomicInteger mints;
    private List<String> handlerArgs;

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        mintBody = new AtomicReference<>();
        mints = new AtomicInteger();
        handlerArgs = new ArrayList<>();
        fs.onJson("POST /auth/login", (body, rec) -> {
            if ("platform_api_key".equals(body.get("grant_type"))) {
                return FakeServer.Reply.json(200, Map.of(
                        "access_token", "pt-12345", "refresh_token", "rt",
                        "expires_in", 300, "subject_type", "platform"));
            }
            // The login response CARRIES an access token on purpose. Without
            // it, mintProductRoles' "no handler and a token already in hand"
            // short-circuit is never reached, and scopesOnlyConsumerStillMints
            // would pass vacuously — it would be proving that a login with no
            // token mints, not that a scopes-only consumer does.
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "at-login",
                    "refresh_token", "rtok",
                    "user", Map.of("id", "u1"),
                    "tenants", List.of(Map.of("tenant_id", "t1", "role", "owner"))));
        });
        fs.onJson("POST /auth/token", (body, rec) -> {
            mints.incrementAndGet();
            mintBody.set(body);
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "minted", "refresh_token", "rtok2",
                    "expires_in", 900, "subject_type", "user",
                    "tenant_id", "t1", "role", "owner"));
        });
    }

    @AfterEach
    void tearDown() { fs.close(); }

    private Realm realmWith(ProductRolesHandler pr, ScopesHandler sc) {
        Realm.Builder b = Realm.builder().realmId("01HREALM").apiKey("rk_live_test")
                .baseUrl(fs.baseUrl).audience("acme.test");
        if (pr != null) b = b.productRoles(pr);
        if (sc != null) b = b.scopes(sc);
        return b.build();
    }

    /** A login resolves SCOPES, with the same handler arguments the refresh lane
     *  gets, and puts them on the wire space-delimited. */
    @Test
    void loginResolvesScopes() {
        Realm realm = realmWith(null, (tenantId, userId) -> {
            handlerArgs.add(tenantId + "/" + userId);
            return List.of("invoices:read");
        });

        Session s = realm.auth().login(LoginRequest.of("firebase", "pt"));

        assertEquals(List.of("t1/u1"), handlerArgs,
                "the scopes handler was never called on the LOGIN lane");
        assertNotNull(mintBody.get());
        assertEquals("invoices:read", mintBody.get().get("scope"));
        assertEquals("minted", s.accessToken());
    }

    /**
     * A {@code scopes} handler ALONE must be enough to trigger the login mint.
     * {@code mintProductRoles} short-circuits when no handler is set and a token
     * is already in hand; if that guard only ever consulted {@code productRoles},
     * a scopes-only consumer would silently never mint at all.
     */
    @Test
    void scopesOnlyConsumerStillMintsOnLogin() {
        Realm realm = realmWith(null, (t, u) -> List.of("invoices:read"));

        realm.auth().login(LoginRequest.of("firebase", "pt"));

        assertEquals(1, mints.get(), "a scopes-only consumer must still mint on login");
    }

    /** Both handlers on one login: one mint, both claims. */
    @Test
    void bothHandlersRideOneLoginMint() {
        Realm realm = realmWith((t, u) -> List.of("dispatch"), (t, u) -> List.of("invoices:read"));

        realm.auth().login(LoginRequest.of("firebase", "pt"));

        assertEquals(1, mints.get(), "the two handlers share ONE mint, they do not each cost one");
        assertEquals(List.of("dispatch"), mintBody.get().get("product_roles"));
        assertEquals("invoices:read", mintBody.get().get("scope"));
    }

    /** Empty and null mint NO claim on the login lane either. */
    @Test
    void emptyOrNullResultMintsNoClaimOnLogin() {
        Realm realm = realmWith((t, u) -> null, (t, u) -> List.of());

        realm.auth().login(LoginRequest.of("firebase", "pt"));

        assertFalse(mintBody.get().containsKey("product_roles"));
        assertFalse(mintBody.get().containsKey("scope"));
    }

    /**
     * The handler's error refuses the mint and HANDS BACK the session, so the
     * caller can recover rather than losing a login that actually succeeded
     * (ADR-102 OQ8 recovery anchor).
     */
    @Test
    void scopesHandlerErrorRefusesTheMint() {
        Realm realm = realmWith(null, (t, u) -> { throw new IllegalStateException("scope store down"); });

        LoginMintException e = assertThrows(LoginMintException.class,
                () -> realm.auth().login(LoginRequest.of("firebase", "pt")));

        assertNotNull(e.session(), "the session must travel on the exception — the login itself succeeded");
        assertEquals("t1", e.tenantId());
        // A DISTINCT exception type, deliberately not RealmException: "your
        // scope handler failed 3 times" and "RealmID refused your mint" are
        // different incidents and must not look alike in a partner's logs.
        Throwable cause = e.getCause();
        assertEquals(ScopesException.class, cause.getClass(),
                "want a ScopesException underneath, got " + cause);
        assertEquals(3, ((ScopesException) cause).attempts(),
                "attempts must be the retry budget shared with product_roles");
        assertEquals(0, mints.get(), "a refused mint must not reach the wire");
    }
}
