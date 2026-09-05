package dev.realmid.sdk.auth;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * {@code docs/design/pre-mint-hook.md} §10.1 — THE NAMED TEST.
 *
 * <p>It must assert the CAUSAL property, not the order of a log: the hook
 * writes a row, and {@link ScopesHandler} reads THAT ROW back and returns
 * exactly what it finds. A test that only records
 * {@code ["hook","scopes"]} in an ordered slice can be satisfied by a
 * reordering that happens to log the same way; this cannot, because the
 * resolver's return value is PRODUCED BY the hook.
 *
 * <p>⚠️ Mutation-verified during development: moving the
 * {@code fireIdentityResolved} call in {@code AuthClient.mintProductRoles} to
 * below {@code ScopeClaims.resolve} turns this RED (the map is empty when
 * {@link ScopesHandler} reads it, so the minted scope is absent rather than
 * {@code "orders:read"}) — see EVIDENCE in the task return for the failing
 * output.
 */
class IdentityResolvedOrderingTest {

    private FakeServer fs;

    private static final Map<String, Object> SESSION = Map.of(
            "access_token", "at-preclaim",
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
                "tenant_id", "t1", "role", "owner",
                // The fake mirrors what the ISSUER would do with the scope the
                // request body carried — the real assertion is on that body,
                // this just keeps the returned session realistic.
                "scope", body.getOrDefault("scope", "")
        )));
    }

    @AfterEach
    void tearDown() { fs.close(); }

    @Test
    void runsBeforeScopeResolutionAndItsWriteIsVisible() {
        Map<String, List<String>> mirror = new ConcurrentHashMap<>();

        Realm realm = Realm.builder().realmId("01HREALM").apiKey("rk_live_test")
                .baseUrl(fs.baseUrl).audience("acme.test")
                .onIdentityResolved(ev -> mirror.put(ev.tenantId() + "+" + ev.userId(),
                        List.of("orders:read")))
                .scopes((tenantId, userId) -> mirror.get(tenantId + "+" + userId))
                .productRoles((tenantId, userId) -> null)
                .build();

        realm.auth().login(new LoginRequest("google", "provider-token", null, null, null));

        FakeServer.Recorded mint = null;
        for (FakeServer.Recorded r : fs.recorded) {
            if ("/auth/token".equals(r.path)) mint = r;
        }
        assertEquals("orders:read", mint.bodyAsMap().get("scope"),
                "the minted /auth/token body must carry the scope the hook's OWN "
                        + "write produced — a reordering that fires the hook after "
                        + "Scopes.resolve would mint no scope claim at all");
    }
}
