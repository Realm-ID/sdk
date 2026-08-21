package dev.realmid.sdk;

import dev.realmid.sdk.auth.LoginRequest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * The ADR-041 realm pin has to be reachable from the way partners actually
 * build the SDK — {@code Realm.builder().realmId(...)} — not merely present on
 * {@link dev.realmid.sdk.platformtoken.PlatformTokenManager}. This workspace
 * has repeatedly shipped a check that was correct one layer below where it had
 * to fire; {@code Realm} constructing the manager without handing it the realm
 * id is exactly that failure, and a manager-only test cannot see it.
 */
class RealmPinWiringTest {
    private static final String CONFIGURED_REALM = "01HREALMA";
    private static final String CREDENTIAL_REALM = "01HREALMB";

    private FakeServer fs;

    @BeforeEach void setUp() throws IOException { fs = new FakeServer(); }
    @AfterEach void tearDown() { fs.close(); }

    private static String jwtWithIssuer(String iss) throws Exception {
        String hdr = b64(FakeServer.M.writeValueAsBytes(Map.of("alg", "RS256", "typ", "JWT")));
        Map<String, Object> claims = new LinkedHashMap<>();
        claims.put("iss", iss);
        claims.put("sub", "bot-user");
        return hdr + "." + b64(FakeServer.M.writeValueAsBytes(claims)) + "." + b64("sig".getBytes());
    }

    private static String b64(byte[] b) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    private Realm realmPinnedTo(String realmId) {
        return Realm.builder()
                .realmId(realmId)
                .apiKey("rk_live_test")
                .baseUrl(fs.baseUrl)
                .audience("acme.test")
                .build();
    }

    @Test
    void aCredentialFromAnotherRealmFailsTheFirstCall() throws Exception {
        // The API key belongs to realm B; the SDK was constructed for realm A.
        fs.on("POST /auth/login", (ex, body) -> {
            try {
                return FakeServer.Reply.json(200, Map.of(
                        "access_token", jwtWithIssuer("https://auth.realmid.dev/" + CREDENTIAL_REALM),
                        "expires_in", 300, "subject_type", "platform"));
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });

        RealmException ex = assertThrows(RealmException.class,
                () -> realmPinnedTo(CONFIGURED_REALM).auth().login(LoginRequest.of("firebase", "tok")));
        assertEquals(ErrorCode.REALM_MISMATCH, ex.getCode(),
                "the pin must fire locally, before the user login is attempted");
    }

    @Test
    void aMatchingCredentialIsUnaffected() throws Exception {
        // POSITIVE CONTROL: proves the wiring above refuses on the MISMATCH and
        // not merely because a Realm-built client cannot log in in this fixture.
        fs.on("POST /auth/login", (ex, body) -> {
            Map<String, Object> b = fs.last().bodyAsMap();
            try {
                if ("platform_api_key".equals(b.get("grant_type"))) {
                    return FakeServer.Reply.json(200, Map.of(
                            "access_token", jwtWithIssuer("https://auth.realmid.dev/" + CONFIGURED_REALM),
                            "expires_in", 300, "subject_type", "platform"));
                }
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "at-1", "refresh_token", "rt-1", "expires_in", 600,
                    "user", Map.of("id", "u1"), "tenants", java.util.List.of()));
        });

        var session = realmPinnedTo(CONFIGURED_REALM).auth().login(LoginRequest.of("firebase", "tok"));
        assertEquals("at-1", session.accessToken());
    }
}
