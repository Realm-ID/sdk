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
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * §5 — the hook's error refuses the mint, unconditionally, no fail-open knob.
 * A partner who wants best-effort behaviour catches their own error inside the
 * handler and returns normally; there is nothing else to configure.
 */
class IdentityResolvedErrorTest {

    private FakeServer fs;
    private AtomicInteger mintCalls;

    private static final Map<String, Object> SESSION = Map.of(
            "access_token", "at-err",
            "refresh_token", "rtok",
            "user", Map.of("id", "u1"),
            "tenants", List.of(Map.of("tenant_id", "t1", "role", "owner")));

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        mintCalls = new AtomicInteger();
        fs.onJson("POST /auth/login", (body, rec) -> FakeServer.Reply.json(200, SESSION));
        fs.onJson("POST /auth/token", (body, rec) -> {
            mintCalls.incrementAndGet();
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "minted", "refresh_token", "rtok2",
                    "expires_in", 900, "subject_type", "user",
                    "tenant_id", "t1", "role", "owner"));
        });
    }

    @AfterEach
    void tearDown() { fs.close(); }

    /**
     * On the LOGIN lane the error rides {@link LoginMintException} — the
     * ADR-102 OQ8 recovery anchor — exactly as a failing
     * {@link ScopesHandler} does today. No {@code /auth/token} call is made:
     * the hook runs BEFORE the mint it would otherwise seed.
     */
    @Test
    void loginHookErrorRidesTheLoginMintExceptionAnchorAndMintsNothing() {
        Realm realm = Realm.builder().realmId("01HREALM").apiKey("rk_live_test")
                .baseUrl(fs.baseUrl).audience("acme.test")
                .onIdentityResolved(ev -> { throw new IllegalStateException("mirror db down"); })
                .build();

        LoginMintException ex = assertThrows(LoginMintException.class,
                () -> realm.auth().login(new LoginRequest("google", "provider-token", null, null, null)));

        assertNotNull(ex.session(), "the session /auth/login created must ride the exception");
        assertEquals("at-err", ex.session().accessToken(),
                "the pre-derived-claims session must be recoverable, not discarded");
        assertTrue(ex.getCause() instanceof IdentityResolvedException);
        assertEquals(0, mintCalls.get(),
                "the hook runs BEFORE the mint — an error there must not reach /auth/token at all");
    }

    /** A partner expresses fail-open with one line: catch and return normally. */
    @Test
    void aPartnerExpressesFailOpenByReturningNormally() {
        Realm realm = Realm.builder().realmId("01HREALM").apiKey("rk_live_test")
                .baseUrl(fs.baseUrl).audience("acme.test")
                // A scopes handler forces the mint that would otherwise be
                // short-circuited (an access token is already in hand and,
                // with no resolver at all, a second round trip would only
                // reproduce it) — the mint reaching /auth/token IS the proof
                // that swallowing the hook's own error let login proceed.
                .scopes((t, u) -> List.of("invoices:read"))
                .onIdentityResolved(ev -> {
                    try {
                        throw new IllegalStateException("mirror db down");
                    } catch (IllegalStateException swallowed) {
                        // best-effort: fall through
                    }
                })
                .build();

        Session s = realm.auth().login(new LoginRequest("google", "provider-token", null, null, null));

        assertFalse(s.accessToken() == null || s.accessToken().isEmpty());
        assertEquals(1, mintCalls.get());
    }

    /**
     * §4.3.2 — on refresh, an unreadable subject becomes a REFUSAL when the
     * hook is configured (today it silently degrades to "claim omitted" for
     * {@link ProductRolesHandler} / {@link ScopesHandler} alone).
     */
    @Test
    void refreshRefusesWhenSubjectIsUnreadableAndHookIsConfigured() {
        Realm realm = Realm.builder().realmId("01HREALM").apiKey("rk_live_test")
                .baseUrl(fs.baseUrl).audience("acme.test")
                .onIdentityResolved(ev -> {})
                .build();

        TokenResponse minted = new TokenResponse("not-a-jwt", "rtok-rotated", 900, 0, 0,
                "user", "t1", null);

        assertThrows(IdentityResolvedException.class,
                () -> realm.auth().enrichRefreshMint(minted, "t1"));
    }

    /** Unchanged for everyone else: no hook configured still degrades silently. */
    @Test
    void refreshStillDegradesSilentlyWithNoHookConfigured() {
        Realm realm = Realm.builder().realmId("01HREALM").apiKey("rk_live_test")
                .baseUrl(fs.baseUrl).audience("acme.test")
                .productRoles((t, u) -> List.of("dispatch"))
                .build();

        TokenResponse minted = new TokenResponse("not-a-jwt", "rtok-rotated", 900, 0, 0,
                "user", "t1", null);

        TokenResponse out = realm.auth().enrichRefreshMint(minted, "t1");
        assertEquals(minted, out, "with no hook configured, an unreadable subject must still degrade, not throw");
    }
}
