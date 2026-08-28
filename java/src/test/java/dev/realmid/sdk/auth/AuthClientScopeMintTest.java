package dev.realmid.sdk.auth;

import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * ADR-097 mint half — {@code TokenRequest.scope}.
 *
 * <p>The ENFORCEMENT half (Scopes / ScopePolicy / ScopeFilter) shipped in all
 * three SDKs. The MINT half shipped in none of them, so the operand those
 * classes evaluate had no way onto the wire from the SDK at all. These tests
 * hold it there.
 */
class AuthClientScopeMintTest {
    private FakeServer fs;
    private Realm realm;
    private AtomicReference<Map<String, Object>> mintBody;
    private AtomicInteger mints;

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        mintBody = new AtomicReference<>();
        mints = new AtomicInteger();
        fs.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("access_token", "pt-12345", "refresh_token", "rt",
                        "expires_in", 300, "subject_type", "platform")));
        fs.on("POST /auth/token", (ex, body) -> {
            mints.incrementAndGet();
            mintBody.set(fs.last().bodyAsMap());
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "at-2", "refresh_token", "rt-2",
                    "expires_in", 900, "subject_type", "user"));
        });
        realm = Realm.builder().realmId("01HREALM").apiKey("rk_live_test")
                .baseUrl(fs.baseUrl).audience("acme.test").build();
    }

    @AfterEach
    void tearDown() { fs.close(); }

    /**
     * The defect test: before this field existed the body carried no
     * {@code scope} key, whatever the caller asked for.
     */
    @Test
    void scopeGoesOnTheWireSpaceDelimitedInOrder() {
        realm.auth().token(TokenRequest.of("rt", "t1")
                .withScope(List.of("orders:read", "orders:write")));
        assertEquals("orders:read orders:write", mintBody.get().get("scope"));
    }

    /**
     * Keyed on emptiness, NOT on null — the inverse of {@code rolePermissions},
     * and for a stated reason: the issuer's {@code parseScope} trims and returns
     * nil for {@code ""}, so an empty scope IS an absent one and
     * {@code "scope": ""} could not mean anything. {@code rolePermissions}
     * differs because an empty list there is a real instruction ("this role
     * confers nothing here"), answered with a 403.
     */
    @Test
    void omitsTheScopeKeyForANullScope() {
        realm.auth().token(TokenRequest.of("rt", "t1"));
        assertFalse(mintBody.get().containsKey("scope"), () -> "body: " + mintBody.get());
    }

    @Test
    void omitsTheScopeKeyForAnEmptyScope() {
        realm.auth().token(TokenRequest.of("rt", "t1").withScope(List.of()));
        assertFalse(mintBody.get().containsKey("scope"), () -> "body: " + mintBody.get());
    }

    /**
     * The reason scope is a {@code List<String>} and not the wire's raw string.
     *
     * <p>A SPACE inside one entry is not a parse error on the wire — it is a
     * SILENT AUTHORITY CHANGE: {@code "orders read"} is read by the issuer as
     * TWO scopes. Taking a list and refusing an unsendable entry turns that into
     * an exception at the call site.
     *
     * <p>The charset is RFC 6749 §3.3 and fixed by spec, which is what makes
     * checking it client-side safe from drift. The per-realm BOUNDS
     * ({@code max_permission_strings} / {@code max_permission_string_len}) are
     * deliberately left to the server: those ARE realm configuration, and a
     * local copy would refuse what the server accepts.
     */
    @ParameterizedTest
    @ValueSource(strings = {
            "orders read",      // an embedded space splits it into two scopes
            "orders\tread",     // a tab is whitespace the issuer also splits on
            "orders\"read",     // DQUOTE is outside the scope-token charset
            "orders\\read",     // BACKSLASH is outside the scope-token charset
            "",                 // an empty entry cannot be represented at all
    })
    void refusesAnUnsendableScopeEntry(String entry) {
        assertRefused(entry);
    }

    /**
     * DEL, built rather than written literally: a raw 0x7F in the source file
     * is invisible in a diff, which is exactly the property that makes it worth
     * testing and the wrong property for a source literal.
     */
    @Test
    void refusesAScopeEntryContainingANonPrintableByte() {
        assertRefused("orders" + (char) 0x7F);
    }

    private void assertRefused(String entry) {
        RealmException e = assertThrows(RealmException.class, () ->
                realm.auth().token(TokenRequest.of("rt", "t1")
                        .withScope(List.of("orders:read", entry))));
        assertEquals(ErrorCode.BAD_REQUEST, e.getCode());
        // The mint must not happen at all — a refusal that still spent the
        // refresh token would rotate it and log the caller out.
        assertEquals(0, mints.get(), "the request must not reach the issuer");
    }
}
