package dev.realmid.sdk.me;

import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import dev.realmid.sdk.auth.Session;
import dev.realmid.sdk.info.RealmConfigResponse;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.http.HttpClient;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** ADR-092 D5 membership self-service + the D4 config/login surface. */
class MeClientTest {
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

    @Test
    void chooseTenantPostsTheKeptTenantAndDecodesReleased() {
        fs.on("POST /me/tenant-choice", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("tenant_id", "t-keep", "status", "chosen", "released", 2)));

        TenantChoiceResult out = realm.me().chooseTenant("t-keep", MeAuth.bearer("user-jwt"));
        // The body names the membership to KEEP, not the ones released.
        assertEquals("t-keep", fs.last().bodyAsMap().get("tenant_id"));
        // Direct mode: the user's own JWT is the wire bearer.
        assertEquals("Bearer user-jwt", fs.last().header("authorization"));
        assertEquals("t-keep", out.tenantId());
        assertEquals("chosen", out.status());
        assertEquals(2, out.released());
    }

    @Test
    void bffModeSendsUserTokenBesideThePlatformBearer() {
        fs.on("POST /me/tenant-choice", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("tenant_id", "t1", "status", "chosen", "released", 1)));

        realm.me().chooseTenant("t1", MeAuth.onBehalfOf("verified-jwt"));
        // The platform token stays the bearer; the verified user JWT is
        // additive. A bare user id is not an identity (issuer v0.66.0), so this
        // header is the only thing naming the caller.
        assertEquals("Bearer pt", fs.last().header("authorization"));
        assertEquals("verified-jwt", fs.last().header("X-User-Token"));
    }

    @Test
    void rejectAndLeaveHitTheirOwnRoutesWithNoBody() {
        fs.on("POST /me/invitations/t1/reject", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("tenant_id", "t1", "status", "rejected")));
        fs.on("POST /me/memberships/t1/leave", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("tenant_id", "t1", "status", "left")));

        MembershipResult rej = realm.me().rejectInvitation("t1", MeAuth.bearer("u"));
        assertEquals("rejected", rej.status());
        assertTrue(fs.last().bodyAsMap().isEmpty(), "reject takes no body");

        MembershipResult left = realm.me().leave("t1", MeAuth.bearer("u"));
        assertEquals("left", left.status());
        assertEquals("t1", left.tenantId());
    }

    @Test
    void ownerCannotBeRevokedKeepsItsSpecificCode() {
        fs.on("POST /me/tenant-choice", (ex, body) -> FakeServer.Reply.json(409,
                Map.of("error", "transfer ownership first", "code", "owner_cannot_be_revoked")));

        RealmException e = assertThrows(RealmException.class,
                () -> realm.me().chooseTenant("t1", MeAuth.bearer("u")));
        // Must NOT collapse into the generic 409 CONFLICT — the remedy
        // (transfer ownership) is specific to this code.
        assertEquals(ErrorCode.OWNER_CANNOT_BE_REVOKED, e.getCode());
    }

    @Test
    void loginDecodesThePickerAlongsideRealTokens() {
        // The platform bootstrap and the user login both hit POST /auth/login,
        // distinguished by grant_type (ADR-051). Branch on it.
        fs.on("POST /auth/login", (ex, raw) -> {
            Map<String, Object> body = fs.last().bodyAsMap();
            if ("platform_api_key".equals(body.get("grant_type"))) {
                return FakeServer.Reply.json(200, Map.of("access_token", "pt",
                        "refresh_token", "rt", "expires_in", 300, "subject_type", "platform"));
            }
            return FakeServer.Reply.json(200, Map.of(
                    // The login SUCCEEDS: the picker rides alongside real tokens.
                    "access_token", "atok", "refresh_token", "rtok", "expires_in", 900,
                    "user", Map.of("id", "u1"),
                    "tenant_choice_required", true,
                    "tenant_choices", List.of(
                            Map.of("tenant_id", "t1", "display_name", "Acme", "is_owner", false),
                            Map.of("tenant_id", "t2", "display_name", "Mine", "is_owner", true))));
        });

        Session s = realm.auth().login(dev.realmid.sdk.auth.LoginRequest.of("google", "tok"));
        assertEquals("atok", s.accessToken());
        assertTrue(s.tenantChoiceRequired());
        assertEquals(2, s.tenantChoices().size());
        assertEquals("t1", s.tenantChoices().get(0).tenantId());
        assertEquals("Acme", s.tenantChoices().get(0).displayName());
        assertFalse(s.tenantChoices().get(0).isOwner());
        // An owned membership cannot be given up — do not offer it.
        assertTrue(s.tenantChoices().get(1).isOwner());
    }

    @Test
    void configGetSurfacesPendingReconciliationBesideConfig() {
        fs.on("GET /platforms/01HREALM/config", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                "id", "01HREALM",
                "config", Map.of("single_tenant_membership", true),
                // Derived, read-only, and deliberately OUTSIDE config.
                "single_tenant_pending_reconciliation", 3)));

        RealmConfigResponse out = realm.config().get();
        assertEquals(Boolean.TRUE, out.config().get("single_tenant_membership"));
        assertFalse(out.config().containsKey("single_tenant_pending_reconciliation"),
                "the derived count must not appear inside the settable config bag");
        assertEquals(Integer.valueOf(3), out.singleTenantPendingReconciliation());
    }

    @Test
    void pendingReconciliationIsNullWhenTheRuleIsOff() {
        fs.on("GET /platforms/01HREALM/config", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                "id", "01HREALM", "config", Map.of("single_tenant_membership", false))));

        // null, not 0: "not reported" and "reported as drained" are different
        // facts, and a caller rendering the number must tell them apart.
        assertNull(realm.config().get().singleTenantPendingReconciliation());
    }
}
