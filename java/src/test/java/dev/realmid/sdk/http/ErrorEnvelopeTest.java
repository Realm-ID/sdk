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

    @Test
    void nestedGatePayloadSurvives() {
        // The shape the ISSUER actually emits, which is why this is a defect
        // and not a hypothetical: GoFr's createErrorResponse merges every key
        // mfaGateError.Response() adds into ONE object and renders it under the
        // top-level `error` field, so mfa_challenge_token / methods / reason /
        // max_age_seconds all arrive INSIDE it. This transport collected only
        // the siblings BESIDE `error`, so a Java caller driving a step-up got an
        // empty details map — a challenge with no token to answer it. sdk/go
        // collected both levels; ts and java did not, until 2026-08-30.
        RealmException e = refusalOn(412, Map.of("error", Map.of(
                "code", "mfa_required",
                "message", "this operation requires a fresh MFA proof",
                "mfa_challenge_token", "chal-xyz",
                "methods", java.util.List.of("totp"),
                "reason", "stale_mfa",
                "max_age_seconds", 300)));
        assertEquals(ErrorCode.MFA_REQUIRED, e.getCode());
        assertEquals("chal-xyz", e.getDetails().get("mfa_challenge_token"),
                "the nested gate payload was dropped: " + e.getDetails());
        assertEquals("stale_mfa", e.getDetails().get("reason"));
        assertEquals(java.util.List.of("totp"), e.getDetails().get("methods"));
        assertEquals(300L, e.getDetails().get("max_age_seconds"));
    }

    @Test
    void nestedSessionLimitPayloadSurvives() {
        RealmException e = refusalOn(412, Map.of("error", Map.of(
                "code", "session_limit_reached",
                "message", "concurrent session limit reached",
                "revocation_token", "tok-abc",
                "active_sessions", java.util.List.of(Map.of("id", "j1")))));
        assertEquals("tok-abc", e.getDetails().get("revocation_token"),
                "the nested gate payload was dropped: " + e.getDetails());
        assertEquals(java.util.List.of(Map.of("id", "j1")), e.getDetails().get("active_sessions"));
    }

    @Test
    void bothLevelsAreCollectedAndNestedWinsACollision() {
        // The RealmID BFF's own step-up envelope puts the challenge BESIDE
        // `error` (ADR-096 D9) while the issuer nests it, so one parser reads
        // both. Nested wins a name collision — the same precedence sdk/go and
        // sdk/ts apply, so a body carrying both never resolves differently
        // depending on which language read it.
        RealmException e = refusalOn(412, Map.of(
                "error", Map.of("code", "mfa_required", "message", "m", "mfa_challenge_token", "inner"),
                "mfa_challenge_token", "outer",
                "tenant_id", "t-1"));
        assertEquals("inner", e.getDetails().get("mfa_challenge_token"));
        assertEquals("t-1", e.getDetails().get("tenant_id"), "the top-level sibling was dropped");
    }

    @Test
    void theNestedEnvelopesOwnCodeMessageAndErrorAreNotDetails() {
        // Collecting the nested siblings must not also spill the envelope's own
        // three keys into details: `code` is narrowed onto getCode() or
        // preserved as server_code, and duplicating it would make a caller's
        // branch on details.get("code") start answering for canonical refusals.
        RealmException e = refusalOn(403, Map.of("error", Map.of(
                "code", "forbidden", "message", "m", "error", "legacy")));
        assertFalse(e.getDetails().containsKey("code"), "details: " + e.getDetails());
        assertFalse(e.getDetails().containsKey("message"), "details: " + e.getDetails());
        assertFalse(e.getDetails().containsKey("error"), "details: " + e.getDetails());
    }
}
