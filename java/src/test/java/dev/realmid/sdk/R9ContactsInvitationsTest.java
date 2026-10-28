package dev.realmid.sdk;

import dev.realmid.sdk.auth.AcceptInvitationRequest;
import dev.realmid.sdk.auth.InvitationInspection;
import dev.realmid.sdk.auth.Session;
import dev.realmid.sdk.info.RealmConfigResponse;
import dev.realmid.sdk.me.ContactProofConfirmed;
import dev.realmid.sdk.me.ContactProofSent;
import dev.realmid.sdk.me.MeAuth;
import dev.realmid.sdk.tenants.Invitation;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.http.HttpClient;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * R7 + R9 (issuer ADR-116 third amendment, ADR-117; spec 0.62.0): unique contact kinds in the realm
 * config, contact proof, and invitation inspect / accept / resend, plus the new error codes.
 */
class R9ContactsInvitationsTest {
    private FakeServer fs;
    private Realm realm;
    private final List<String> queries = new ArrayList<>();

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        fs.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("access_token", "pt", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform")));
        realm = Realm.builder().sessionStore(new dev.realmid.sdk.session.MemorySessionStore())
                .realmId("01HREALM").apiKey("rk").baseUrl(fs.baseUrl).audience("acme.test")
                .httpClient(HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build())
                .build();
    }

    @AfterEach
    void tearDown() { fs.close(); }

    // ---- 1. realm config -------------------------------------------------------------------

    @Test
    void configReadExposesUniqueKindsAndReport() {
        fs.on("GET /platforms/01HREALM/config", (ex, b) -> FakeServer.Reply.json(200, Map.of(
                "id", "01HREALM",
                "config", Map.of("contacts", Map.of("unique_kinds", List.of("email"))),
                "unique_kinds_report", Map.of(
                        "email", Map.of("values_on_multiple_memberships", 3),
                        "phone", Map.of("values_on_multiple_memberships", 0)))));
        RealmConfigResponse c = realm.config().get();
        assertEquals(List.of("email"), c.uniqueKinds().orElseThrow());
        assertEquals(3, c.uniqueKindsReport().get("email").valuesOnMultipleMemberships());
        assertEquals(0, c.uniqueKindsReport().get("phone").valuesOnMultipleMemberships());
    }

    @Test
    void emptyUniqueKindsIsNotAbsent() {
        fs.on("GET /platforms/01HREALM/config", (ex, b) -> FakeServer.Reply.json(200, Map.of(
                "id", "01HREALM", "config", Map.of("contacts", Map.of("unique_kinds", List.of())))));
        RealmConfigResponse c = realm.config().get();
        assertTrue(c.uniqueKinds().orElseThrow().isEmpty());
        assertTrue(c.uniqueKindsReport().isEmpty(), "report omitted when the count could not be taken");
    }

    @Test
    void absentUniqueKindsIsEmptyOptional() {
        fs.on("GET /platforms/01HREALM/config", (ex, b) -> FakeServer.Reply.json(200, Map.of(
                "id", "01HREALM", "config", Map.of())));
        assertTrue(realm.config().get().uniqueKinds().isEmpty());
    }

    @Test
    void updateWithConfirmLockoutSendsQueryParameter() {
        fs.on("PATCH /platforms/01HREALM/config", (ex, b) -> {
            queries.add(String.valueOf(ex.getRequestURI().getRawQuery()));
            return FakeServer.Reply.json(200, Map.of());
        });
        realm.config().update(Map.of("contacts", Map.of("unique_kinds", List.of("phone"))), true);
        assertEquals("confirm_lockout=true", queries.get(0));
        assertEquals(Map.of("contacts", Map.of("unique_kinds", List.of("phone"))), fs.last().bodyAsMap());
        realm.config().update(Map.of("contacts", Map.of("unique_kinds", List.of("phone"))));
        assertEquals("null", queries.get(1), "the one-argument update sends no query");
    }

    // ---- 2. contact proof ------------------------------------------------------------------

    @Test
    void sendContactProofPostsDeliveryModeAndDecodesDelivered() {
        fs.on("POST /me/contacts/c-1/proof", (ex, b) -> FakeServer.Reply.json(200, Map.of("delivered", "sms")));
        ContactProofSent out = realm.me().sendContactProof("c-1", "sms", MeAuth.onBehalfOf("user-jwt"));
        assertEquals("sms", out.delivered());
        assertEquals("sms", fs.last().bodyAsMap().get("delivery_mode"));
        assertEquals("user-jwt", fs.last().header("x-user-token"));
    }

    @Test
    void sendContactProofDecodesGoFrWrappedBody() {
        fs.on("POST /me/contacts/c-1/proof", (ex, b) ->
                FakeServer.Reply.json(200, Map.of("data", Map.of("delivered", "whatsapp"))));
        assertEquals("whatsapp", realm.me().sendContactProof("c-1", "whatsapp", MeAuth.onBehalfOf("u")).delivered());
    }

    @Test
    void confirmContactProofPostsCodeAndDecodesContact() {
        fs.on("POST /me/contacts/c-1/proof/confirm", (ex, b) -> FakeServer.Reply.json(200, Map.of(
                "id", "c-1", "kind", "phone", "value", "+919999000011", "verified", true,
                "verified_at", "2026-10-19T10:00:00Z")));
        ContactProofConfirmed out = realm.me().confirmContactProof("c-1", "123456", MeAuth.onBehalfOf("user-jwt"));
        assertEquals("123456", fs.last().bodyAsMap().get("code"));
        assertEquals("c-1", out.id());
        assertEquals("phone", out.kind());
        assertEquals("+919999000011", out.value());
        assertTrue(out.verified());
        assertEquals(java.time.Instant.parse("2026-10-19T10:00:00Z"), out.verifiedAt());
    }

    @Test
    void contactProofErrorsAreRegistered() {
        fs.on("POST /me/contacts/c-1/proof", (ex, b) -> FakeServer.Reply.json(409,
                Map.of("error", Map.of("code", "contact_already_verified", "message", "m"))));
        RealmException e = assertThrows(RealmException.class,
                () -> realm.me().sendContactProof("c-1", "sms", MeAuth.onBehalfOf("u")));
        assertEquals(ErrorCode.CONTACT_ALREADY_VERIFIED, e.getCode());
    }

    // ---- 3. invitations --------------------------------------------------------------------

    @Test
    void inspectInvitationPostsTokenInBodyAndDecodes() {
        fs.on("POST /auth/invitations/inspect", (ex, b) -> FakeServer.Reply.json(200, Map.of(
                "tenant_id", "t-1", "tenant_display_name", "Acme", "expires_at", "2026-10-26T00:00:00Z")));
        InvitationInspection out = realm.auth().inspectInvitation("tok");
        assertEquals("tok", fs.last().bodyAsMap().get("token"));
        assertEquals("t-1", out.tenantId());
        assertEquals("Acme", out.tenantDisplayName());
        assertEquals(java.time.Instant.parse("2026-10-26T00:00:00Z"), out.expiresAt());
    }

    @Test
    void invalidInvitationTokenIsRegistered() {
        fs.on("POST /auth/invitations/inspect", (ex, b) -> FakeServer.Reply.json(400,
                Map.of("error", Map.of("code", "invalid_invitation_token", "message", "m"))));
        RealmException e = assertThrows(RealmException.class, () -> realm.auth().inspectInvitation("x"));
        assertEquals(ErrorCode.INVALID_INVITATION_TOKEN, e.getCode());
    }

    @Test
    void acceptInvitationReturnsThePasswordGrantSession() {
        fs.on("POST /auth/invitations/accept", (ex, b) -> FakeServer.Reply.json(200, Map.of(
                "access_token", "at-user", "refresh_token", "rt-user", "expires_in", 300,
                "subject_type", "user", "tenant_id", "t-1")));
        Session s = realm.auth().acceptInvitation(new AcceptInvitationRequest("tok", "alice", "a-long-password", null));
        Map<String, Object> body = fs.recorded.stream().filter(x -> x.path.equals("/auth/invitations/accept")).findFirst().orElseThrow().bodyAsMap();
        assertEquals("tok", body.get("token"));
        assertEquals("alice", body.get("username"));
        assertEquals("a-long-password", body.get("password"));
        assertEquals("at-user", s.accessToken()); // the /auth/token mint (shim echo), R44
    }

    @Test
    void acceptInvitationSurfacesTheMfaChallengeLikeTheLogin() {
        fs.on("POST /auth/invitations/accept", (ex, b) -> FakeServer.Reply.json(412, Map.of(
                "error", Map.of("code", "mfa_required", "message", "MFA required"),
                "mfa_challenge_token", "ch-token-abc", "methods", List.of("totp"))));
        RealmException e = assertThrows(RealmException.class, () ->
                realm.auth().acceptInvitation(new AcceptInvitationRequest("tok", "alice", "pw", null)));
        assertEquals(ErrorCode.MFA_REQUIRED, e.getCode());
        assertEquals("ch-token-abc", e.getDetails().get("mfa_challenge_token"));
    }

    @Test
    void acceptRequestNeverPrintsTheSecrets() {
        String s = new AcceptInvitationRequest("tok-secret", "alice", "pw-secret", null).toString();
        assertFalse(s.contains("tok-secret"));
        assertFalse(s.contains("pw-secret"));
    }

    @Test
    void resendPostsToTheResendRouteAndDecodesTheInvitation() {
        fs.on("POST /tenants/t-1/invitations/inv-9/resend", (ex, b) -> FakeServer.Reply.json(200,
                Map.of("id", "inv-9", "status", "pending")));
        Invitation inv = realm.tenants().invitations().resend("t-1", "inv-9");
        assertEquals("POST", fs.last().method);
        assertEquals("/tenants/t-1/invitations/inv-9/resend", fs.last().path);
        assertEquals("inv-9", inv.id());
    }

    // ---- 4. error codes --------------------------------------------------------------------

    @Test
    void everyNewCodeResolves() {
        for (String c : List.of("unique_kinds_requires_password", "password_login_required",
                "unique_kind_lockout", "unique_kind_lockout_check_failed", "unique_kind_duplicates",
                "email_keyed_signin_enabled", "require_verified_email_conflict",
                "idp_requires_identifying_email", "idp_requires_identifying_phone",
                "domain_sso_requires_unique_email", "invite_contact_not_identifying",
                "recipient_email_not_identifying", "invalid_invitation_token", "contact_not_found",
                "contact_already_verified", "contact_changed", "reset_email_not_identifying")) {
            ErrorCode e = ErrorCode.fromWire(c);
            assertNotNull(e, c);
            assertEquals(c, e.wire());
        }
    }
}
