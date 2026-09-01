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
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ADR-102 D10/D11 in the Java SDK, plus the parity surface
 * ({@code needsTenantChoice} / {@code selectTenant} / {@code mfaRequired})
 * ported from Go.
 */
class ProductRolesTest {

    private FakeServer fs;
    private AtomicReference<Map<String, Object>> mintBody;
    private AtomicInteger mints;
    private List<String> handlerTenants;

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        mintBody = new AtomicReference<>();
        mints = new AtomicInteger();
        handlerTenants = new ArrayList<>();
        fs.on("POST /auth/token", (ex, body) -> {
            mints.incrementAndGet();
            mintBody.set(fs.last().bodyAsMap());
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "minted", "refresh_token", "rtok2",
                    "expires_in", 900, "subject_type", "user"));
        });
    }

    @AfterEach
    void tearDown() { fs.close(); }

    /**
     * The platform bootstrap and the user login share POST /auth/login, so the
     * handler discriminates on grant_type — the same shape the Go SDK's test
     * server uses.
     */
    private void serveLogin(Object userLoginBody) {
        fs.onJson("POST /auth/login", (body, rec) -> {
            if ("platform_api_key".equals(body.get("grant_type"))) {
                return FakeServer.Reply.json(200, Map.of(
                        "access_token", "pt-12345", "refresh_token", "rt",
                        "expires_in", 300, "subject_type", "platform"));
            }
            return FakeServer.Reply.json(200, userLoginBody);
        });
    }

    private Realm realmWith(ProductRolesHandler h) {
        Realm.Builder b = Realm.builder().realmId("01HREALM").apiKey("rk_live_test")
                .baseUrl(fs.baseUrl).audience("acme.test");
        if (h != null) b = b.productRoles(h);
        return b.build();
    }

    /** D10 — a single-tenant login MINTS, and the handler's output rides it. */
    @Test
    void singleTenantLoginMints() {
        serveLogin(Map.of(
                "refresh_token", "rtok",
                "user", Map.of("id", "u1"),
                "tenants", List.of(Map.of("tenant_id", "t1", "role", "owner"))));
        Realm realm = realmWith((tenantId, userId) -> {
            handlerTenants.add(tenantId + "/" + userId);
            // A SPACE is legitimate: this is NOT the RFC 6749 §3.3 scope
            // charset, and a JSON array has no delimiter to break.
            return List.of("dispatch", "Regional Manager");
        });

        Session s = realm.auth().login(LoginRequest.of("firebase", "pt"));

        assertEquals(1, mints.get());
        assertEquals(List.of("t1/u1"), handlerTenants);
        assertEquals(List.of("dispatch", "Regional Manager"), mintBody.get().get("product_roles"));
        assertEquals("minted", s.accessToken());
        assertEquals("rtok2", s.refreshToken());
        assertEquals("t1", s.tenantId());
        assertEquals("owner", s.role());
    }

    /**
     * D10 — a MULTI-tenant login does NOT mint until the caller chooses.
     *
     * <p>⚠️ The failure this guards is silent: auto-picking {@code tenants[0]}
     * would mint for an arbitrary org and resolve THAT org's roles — a wrong
     * answer, not an error.
     */
    @Test
    void multiTenantLoginDoesNotMintUntilTheCallerChooses() {
        serveLogin(Map.of(
                "refresh_token", "rtok",
                "user", Map.of("id", "u1"),
                "tenants", List.of(
                        Map.of("tenant_id", "t1", "role", "member"),
                        Map.of("tenant_id", "t2", "role", "owner", "mfa_required", true))));
        Realm realm = realmWith((tenantId, userId) -> {
            handlerTenants.add(tenantId);
            return List.of("role-of-" + tenantId);
        });

        Session s = realm.auth().login(LoginRequest.of("firebase", "pt"));
        assertEquals(0, mints.get(), "a multi-tenant login must NOT mint");
        assertTrue(handlerTenants.isEmpty(), "the handler must not run before a tenant is chosen");
        assertTrue(s.needsTenantChoice());
        // The ported mfaRequired field must survive the wire mapping.
        assertTrue(s.tenants().get(1).mfaRequired());

        // Choose t2 — deliberately NOT tenants[0], so an auto-pick is visible.
        Session done = realm.auth().completeLogin(s, "t2", null);
        assertEquals(1, mints.get());
        assertEquals(List.of("t2"), handlerTenants);
        assertEquals(List.of("role-of-t2"), mintBody.get().get("product_roles"));
        assertEquals("t2", done.tenantId());
        assertEquals("owner", done.role());
    }

    /**
     * A tenant the session does not hold is refused LOCALLY. The issuer's answer
     * ({@code invalid_credentials}) would read as a login failure rather than
     * the caller bug it is.
     */
    @Test
    void completeLoginRefusesAnUnheldTenant() {
        serveLogin(Map.of("refresh_token", "rtok", "user", Map.of("id", "u1"),
                "tenants", List.of(
                        Map.of("tenant_id", "t1", "role", "member"),
                        Map.of("tenant_id", "t2", "role", "owner"))));
        Realm realm = realmWith((t, u) -> List.of("x"));
        Session s = realm.auth().login(LoginRequest.of("firebase", "pt"));

        assertThrows(IllegalArgumentException.class, () -> realm.auth().completeLogin(s, "t9", null));
        assertThrows(IllegalArgumentException.class, () -> realm.auth().completeLogin(s, "", null));
        assertEquals(0, mints.get(), "nothing may leave for a caller-side mistake");
    }

    /** D11 rule 1 — no handler means no claim, no error, and NO extra round trip. */
    @Test
    void noHandlerCostsNothing() {
        serveLogin(Map.of(
                "access_token", "atok", "refresh_token", "rtok", "expires_in", 900,
                "user", Map.of("id", "u1"),
                "tenants", List.of(Map.of("tenant_id", "t1", "role", "owner"))));
        Realm realm = realmWith(null);
        Session s = realm.auth().login(LoginRequest.of("firebase", "pt"));
        assertEquals(0, mints.get());
        assertEquals("atok", s.accessToken());
    }

    /** D11 rule 2 — an empty handler result mints NO claim, not {@code []}. */
    @Test
    void emptyMintsNoClaim() {
        serveLogin(Map.of("refresh_token", "rtok", "user", Map.of("id", "u1"),
                "tenants", List.of(Map.of("tenant_id", "t1", "role", "owner"))));
        Realm realm = realmWith((t, u) -> List.of());
        realm.auth().login(LoginRequest.of("firebase", "pt"));
        assertFalse(mintBody.get().containsKey("product_roles"),
                "absent and empty must mean the same thing — every token issued before "
                        + "ADR-102 has no claim at all");
    }

    /**
     * D11 rule 3 — a failing handler RETRIES, then REFUSES the mint, and the
     * error is the PARTNER'S.
     */
    @Test
    void failingHandlerRetriesThenRefuses() {
        serveLogin(Map.of("refresh_token", "rtok", "user", Map.of("id", "u1"),
                "tenants", List.of(Map.of("tenant_id", "t1", "role", "owner"))));
        AtomicInteger attempts = new AtomicInteger();
        Realm realm = realmWith((t, u) -> {
            attempts.incrementAndGet();
            throw new IllegalStateException("role db unavailable");
        });

        long started = System.currentTimeMillis();
        // ADR-102 OQ8 — the failure arrives WRAPPED in a LoginMintException so
        // the session (the recovery anchor) has somewhere to ride.
        LoginMintException e = assertThrows(LoginMintException.class,
                () -> realm.auth().login(LoginRequest.of("firebase", "pt")));

        assertEquals(ProductRoles.ATTEMPTS, attempts.get(), "initial + 2 retries");
        assertEquals(0, mints.get(), "the mint must not be attempted after the handler gave up");
        assertEquals("t1", e.tenantId());
        // THE ANCHOR. Throwing a bare exception would drop it.
        assertNotNull(e.session(), "the session must ride on the exception");
        assertEquals("rtok", e.session().refreshToken());
        // The partner's own failure is the cause, and it is a
        // ProductRolesException — never a RealmException. Your outage and ours
        // are different incidents.
        assertTrue(e.getCause() instanceof ProductRolesException,
                "cause must be a ProductRolesException, got " + e.getCause());
        assertNotNull(e.getCause().getCause());
        // The retry budget is BOUNDED (~200ms): this is the login hot path with
        // a human waiting on it.
        assertTrue(System.currentTimeMillis() - started < 3000,
                "the retry budget must be bounded");
    }

    /**
     * {@code selectTenant} is the Go-parity helper, and its {@code tenants[0]}
     * fallback is exactly why it must NOT settle the D10 multi-tenant branch.
     */
    @Test
    void selectTenantPrefersCallerThenSessionThenFirst() {
        Session s = new Session(null, "r", 0, 0, 0, null, null,
                Map.of("id", "u1"),
                List.of(new Session.TenantRef("t1", "member", null, false),
                        new Session.TenantRef("t2", "owner", null, false)),
                null, null, null, null, null, null, false, null, null, null);
        assertEquals("t2", s.selectTenant("t2").tenantId());
        assertEquals("owner", s.selectTenant("t2").role());
        assertEquals("t1", s.selectTenant(null).tenantId());
    }
}
