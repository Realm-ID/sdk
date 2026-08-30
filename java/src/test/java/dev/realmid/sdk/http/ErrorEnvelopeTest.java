package dev.realmid.sdk.http;

import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.http.HttpClient;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * The error-envelope seam, driven end-to-end through the transport (its mapper
 * is private, and a test that re-implemented it would assert nothing).
 *
 * <p>Found 2026-08-30 alongside the same defect in {@code sdk/go}: a {@code
 * code} the {@link ErrorCode} union does not name was DROPPED — {@code
 * fromWire} returned null, the code fell back to the status mapping, and the
 * sibling sweep excluded {@code code} — so ADR-101's own 403, {@code
 * role_owner_only}, reached a Java caller as an undifferentiated {@code
 * FORBIDDEN}. It is preserved under {@code details["server_code"]}, the key
 * {@code sdk/ts} already ships for this.
 */
class ErrorEnvelopeTest {
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

    private RealmException refusalOn(int status, Object body) {
        fs.on("GET /platforms/01HREALM/roles", (ex, b) -> FakeServer.Reply.json(status, body));
        return assertThrows(RealmException.class, () -> realm.roles().list());
    }

    @Test
    void nestedUncanonicalCodeSurvivesInDetails() {
        RealmException e = refusalOn(403, Map.of("error", Map.of(
                "code", "role_owner_only",
                "message", "only the owner may seat this role")));
        assertEquals(ErrorCode.FORBIDDEN, e.getCode(), "the union cannot carry it, so Code is status-derived");
        assertEquals("only the owner may seat this role", e.getMessage());
        assertEquals("role_owner_only", e.getDetails().get("server_code"),
                "the specific code vanished: " + e.getDetails());
    }

    @Test
    void flatUncanonicalCodeSurvivesInDetails() {
        RealmException e = refusalOn(403, Map.of(
                "error", "only the owner may seat this role",
                "code", "role_owner_only"));
        assertEquals(ErrorCode.FORBIDDEN, e.getCode());
        assertEquals("role_owner_only", e.getDetails().get("server_code"),
                "the specific code vanished: " + e.getDetails());
    }

    @Test
    void nestedLegacyErrorStringIsTheMessage() {
        // `{"error":{"code":…,"error":"<msg>"}}` with no `message` key. The flat
        // branch has always fallen back to the `error` string; the nested one
        // did not, so the caller got the synthetic "GET … failed with HTTP 403".
        RealmException e = refusalOn(403, Map.of("error", Map.of(
                "code", "forbidden", "error", "not the tenant owner")));
        assertEquals("not the tenant owner", e.getMessage());
        assertEquals(ErrorCode.FORBIDDEN, e.getCode());
    }

    @Test
    void aCanonicalCodeIsNotAlsoCopiedIntoDetails() {
        // The other half of the rule. Without it, a mutation that preserves
        // EVERY stated code passes, and every canonical refusal starts carrying
        // a redundant server_code a caller may then branch on.
        RealmException e = refusalOn(412, Map.of("error", Map.of(
                "code", "mfa_required", "message", "step up")));
        assertEquals(ErrorCode.MFA_REQUIRED, e.getCode());
        assertFalse(e.getDetails().containsKey("server_code"),
                "a canonical code must not be duplicated into details: " + e.getDetails());
    }

    @Test
    void anUncodedGoFrMiddleware401StillMapsFromTheStatus() {
        // The control: the OTHER envelope shape, where there is no code at all.
        RealmException e = refusalOn(401, Map.of("error", "invalid Authorization header"));
        assertEquals(ErrorCode.UNAUTHORIZED, e.getCode());
        assertEquals("invalid Authorization header", e.getMessage());
        assertFalse(e.getDetails().containsKey("server_code"));
    }
}
