package dev.realmid.sdk.integrations;

import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import java.io.IOException;
import java.net.http.HttpClient;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

class IntegrationsClientTest {
    private FakeServer fs;
    private Realm realm;

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        fs.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("access_token", "pt", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform")));
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
    void registerPostsPlatformRouteAndMapsFields() {
        fs.onJson("POST /platforms/01HREALM/integrations", (body, rec) -> {
            assertEquals("hiring-motion", body.get("slug"));
            assertEquals("Hiring Motion", body.get("display_name"));
            assertEquals("Bearer pt", rec.header("authorization"));
            return FakeServer.Reply.json(201, Map.of(
                    "id", "intg-1", "realm_id", "01HREALM", "slug", "hiring-motion",
                    "display_name", "Hiring Motion", "listed", false, "disabled", false));
        });
        Integration out = realm.integrations().register(new IntegrationCreate("hiring-motion", "Hiring Motion"));
        assertEquals("intg-1", out.id());
        assertEquals("hiring-motion", out.slug());
    }

    @Test
    void registerSlugTakenMapsErrorCode() {
        fs.on("POST /platforms/01HREALM/integrations", (ex, body) -> FakeServer.Reply.json(409, Map.of(
                "error", Map.of("code", "slug_taken", "message", "taken"))));
        RealmException ex = assertThrows(RealmException.class, () ->
                realm.integrations().register(new IntegrationCreate("dup", "Dup")));
        assertEquals(ErrorCode.SLUG_TAKEN, ex.getCode());
    }

    /**
     * The install body must carry the ADR-101 D7 STATED PERMISSION LIST.
     *
     * <p>This test previously asserted the body carried {@code role_id}, which
     * is why the SDK shipped broken against the live issuer for as long as it
     * did: the issuer replaced {@code role_id} with {@code permissions} and
     * answers {@code 400 permissions_required}, while the test pinned the old
     * shape and stayed green. A test that asserts the implementation protects
     * the bug.
     */
    @Test
    void installPostsPermissionListAndNoRoleIdToTenantRoute() {
        fs.onJson("POST /tenants/t1/integration-installations", (body, rec) -> {
            assertEquals("intg-1", body.get("integration_id"));
            assertEquals(List.of("users:read"), body.get("permissions"));
            // Asserting only that `permissions` is present would still pass if
            // the client also sent the retired `role_id`.
            assertFalse(body.containsKey("role_id"),
                    "role_id must not be sent — the issuer retired it (ADR-101 D7): " + body);
            return FakeServer.Reply.json(201, Map.of(
                    "id", "inst-1", "integration_id", "intg-1",
                    "permissions", List.of("users:read"),
                    "principal_user_id", "u-9", "status", "installed"));
        });
        InstallResult out = realm.integrations().install("t1",
                new InstallRequest("intg-1", List.of("users:read")));
        assertEquals("inst-1", out.id());
        assertEquals("installed", out.status());
        assertEquals(List.of("users:read"), out.permissions());
    }

    /**
     * The three refusals the permission-stated install can produce. None of
     * them existed while the SDK was still sending role_id, so none was mapped.
     */
    @ParameterizedTest
    @CsvSource({
            "permissions_required,400,PERMISSIONS_REQUIRED",
            "unknown_permission,400,UNKNOWN_PERMISSION",
            "permissions_exceed_grantor,403,PERMISSIONS_EXCEED_GRANTOR",
    })
    void installPermissionRefusalsMapErrorCode(String wire, int status, ErrorCode want) {
        fs.on("POST /tenants/t1/integration-installations", (ex, body) -> FakeServer.Reply.json(status, Map.of(
                "error", Map.of("code", wire, "message", wire))));
        RealmException ex = assertThrows(RealmException.class, () ->
                realm.integrations().install("t1", new InstallRequest("intg-1", List.of("users:read"))));
        assertEquals(want, ex.getCode());
    }

    /**
     * RETAINED FOR THE MAPPING ONLY: the issuer has not emitted
     * {@code role_not_service_typed} since ADR-101 D7, so this asserts the code
     * still resolves for anyone branching on it, NOT that the refusal can still
     * occur.
     */
    @Test
    void installRoleNotServiceTypedMapsErrorCode() {
        fs.on("POST /tenants/t1/integration-installations", (ex, body) -> FakeServer.Reply.json(400, Map.of(
                "error", Map.of("code", "role_not_service_typed", "message", "no"))));
        RealmException ex = assertThrows(RealmException.class, () ->
                realm.integrations().install("t1", new InstallRequest("intg-1", List.of("users:read"))));
        assertEquals(ErrorCode.ROLE_NOT_SERVICE_TYPED, ex.getCode());
    }

    @Test
    void listInstallationsUnwrapsPage() {
        // Map.of rejects null values, so next_cursor is omitted entirely — the
        // client's page reader defaults a missing/null cursor to null.
        fs.on("GET /tenants/t1/integration-installations", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                "items", List.of(Map.of("id", "inst-1", "integration_id", "intg-1",
                        "permissions", List.of("users:read", "users:manage"), "mint_count", 3)))));
        InstallationListPage page = realm.integrations().listInstallations("t1");
        assertEquals(1, page.items().size());
        assertEquals(List.of("users:read", "users:manage"), page.items().get(0).permissions());
        assertEquals(3, page.items().get(0).mintCount());
        assertNull(page.nextCursor());
    }

    @Test
    void mintTokenSendsRawKeyWithoutBearerAndDecodesAccessOnly() {
        // Override /auth/login to branch on grant_type: the mint response, not
        // the platform bootstrap. The mint uses skipPlatformToken, so no bearer.
        fs.onJson("POST /auth/login", (body, rec) -> {
            if ("integration_installation".equals(body.get("grant_type"))) {
                assertEquals("rk_live_src", body.get("api_key"));
                assertEquals("inst-1", body.get("installation_id"));
                assertEquals("org-a", body.get("source_org_id"));
                assertNull(rec.header("authorization"));
                return FakeServer.Reply.json(200, Map.of(
                        "status", "ok", "subject_type", "service",
                        "access_token", "brokered-jwt", "expires_in", 600,
                        "tenant_id", "t-target", "role", "svc"));
            }
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "pt", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform"));
        });
        IntegrationMintResult out = realm.integrations().mintToken(
                new IntegrationMintRequest("rk_live_src", "inst-1", "org-a"));
        assertEquals("brokered-jwt", out.accessToken());
        assertEquals(600, out.expiresIn());
        assertEquals("svc", out.role());
    }

    @Test
    void mintTokenKeyClassMismatchMapsErrorCode() {
        fs.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(401, Map.of(
                "error", Map.of("code", "key_class_mismatch", "message", "no"))));
        RealmException ex = assertThrows(RealmException.class, () ->
                realm.integrations().mintToken(new IntegrationMintRequest("rk_live_svc", "inst-1", "o")));
        assertEquals(ErrorCode.KEY_CLASS_MISMATCH, ex.getCode());
    }
}
