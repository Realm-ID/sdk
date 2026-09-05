package dev.realmid.sdk.roles;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.http.HttpClient;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** ADR-101 D1's write side — RealmID's role VOCABULARY. */
class RoleTemplatesClientTest {
    private FakeServer fs;
    private Realm realm;
    private static final ObjectMapper M = new ObjectMapper();

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

    /**
     * A JSON null list must become an empty list. It is the shape that otherwise
     * reaches an iterating caller as a null.
     */
    @Test
    void listNeverReturnsNull() {
        Map<String, Object> nullList = new HashMap<>();
        nullList.put("role_templates", null);
        fs.on("GET /platforms/01HREALM/role-templates",
                (ex, body) -> FakeServer.Reply.json(200, nullList));
        List<RoleTemplate> out = realm.roleTemplates().list("tenant");
        assertNotNull(out);
        assertTrue(out.isEmpty());
    }

    /**
     * realmsStamped is the difference between "exists for future realms" and
     * "reached the realms that already exist". Only the second is what ADR-101
     * promises, so the SDK must surface it rather than drop it.
     */
    @Test
    void createSurfacesRealmsStampedAndAlwaysSendsAssignableTo() {
        AtomicReference<String> seen = new AtomicReference<>();
        fs.on("POST /platforms/01HREALM/role-templates", (HttpExchange ex, byte[] body) -> {
            seen.set(new String(body));
            return FakeServer.Reply.json(200, Map.of(
                    "role_template", Map.of(
                            "id", "tpl1", "level", "tenant", "name", "reporting",
                            "display_name", "Reporting", "permissions", List.of("audit:read"),
                            "assignable_to", List.of("human"),
                            "is_system", false, "optional", false),
                    "realms_stamped", 7));
        });
        RoleTemplateCreated out = realm.roleTemplates().create(
                new RoleTemplateCreate("tenant", "reporting", "Reporting",
                        List.of("audit:read"), List.of("human"), null, null));
        assertEquals(7, out.realmsStamped());
        assertEquals("reporting", out.roleTemplate().name());
        // Required server-side; a body that silently omits it is a 400 the
        // caller cannot diagnose from the code alone.
        assertTrue(seen.get().contains("assignable_to"), "body was: " + seen.get());
    }

    /**
     * -1 means "could not count". Reading it as 0 would turn "unknown" into a
     * clean bill of health nobody issued.
     */
    @Test
    void updateKeepsUncountableDriftDistinctFromNone() {
        AtomicReference<String> seen = new AtomicReference<>();
        fs.on("PATCH /platforms/01HREALM/role-templates/tpl1", (HttpExchange ex, byte[] body) -> {
            seen.set(new String(body));
            return FakeServer.Reply.json(200, Map.of(
                    "role_template", Map.of("id", "tpl1", "level", "tenant", "name", "reporting"),
                    "drifted_realms", -1));
        });
        RoleTemplatePatched out = realm.roleTemplates()
                .update("tpl1", RoleTemplatePatch.displayName("Reporting v2"));
        assertEquals(-1, out.driftedRealms());
        assertTrue(out.driftUnknown(), "-1 must read as UNKNOWN, never as no drift");

        // An unset field is OMITTED, not sent as null: absent preserves the
        // stored value, a null would be a decision the caller never made.
        String body = seen.get();
        assertTrue(body.contains("display_name"), body);
        assertFalse(body.contains("permissions"), body);
        assertFalse(body.contains("assignable_to"), body);
        assertFalse(body.contains("is_system"), body);
        assertFalse(body.contains("optional"), body);
    }

    /**
     * role_template_seated (409) is RECOVERABLE — the issuer's
     * override_seated=true query parameter rescues it. Neither code joins the
     * general ErrorCode union (matching role_authoring_retired and the rest of
     * this family), so it survives only via details["server_code"], the same
     * seam ErrorEnvelopeTest exercises for role_owner_only.
     */
    @Test
    void updateRefusesWithSeatedSentinelWhenPrincipalsAreSeated() {
        fs.on("PATCH /platforms/01HREALM/role-templates/tpl1", (ex, body) ->
                FakeServer.Reply.json(409, Map.of("error", Map.of(
                        "code", "role_template_seated",
                        "message", "principals are seated at this template"))));
        RealmException e = assertThrows(
                RealmException.class,
                () -> realm.roleTemplates().update("tpl1", RoleTemplatePatch.displayName("x")));
        assertEquals(409, e.getHttpStatus());
        assertEquals("role_template_seated", e.getDetails().get("server_code"),
                "the specific code vanished: " + e.getDetails());
    }

    /**
     * role_template_seat_check_failed (503) is UNCONDITIONAL — unlike
     * role_template_seated, override_seated=true does NOT rescue it, because
     * there is no seat count to override, only an inability to compute one.
     */
    @Test
    void deleteRefusesWithSeatCheckFailedSentinelWhenCountCannotBeTaken() {
        fs.on("DELETE /platforms/01HREALM/role-templates/tpl1", (ex, body) ->
                FakeServer.Reply.json(503, Map.of("error", Map.of(
                        "code", "role_template_seat_check_failed",
                        "message", "seat count could not be taken"))));
        RealmException e = assertThrows(
                RealmException.class,
                () -> realm.roleTemplates().delete("tpl1"));
        assertEquals(503, e.getHttpStatus());
        assertEquals("role_template_seat_check_failed", e.getDetails().get("server_code"),
                "the specific code vanished: " + e.getDetails());
    }

    /** Deleting the recipe leaves the stamped roles standing; the count says so. */
    @Test
    void deleteReportsOrphans() {
        fs.on("DELETE /platforms/01HREALM/role-templates/tpl1", (ex, body) ->
                FakeServer.Reply.json(200, Map.of("status", "deleted", "realms_still_holding", 3)));
        RoleTemplateDeleted out = realm.roleTemplates().delete("tpl1");
        assertEquals("deleted", out.status());
        assertEquals(3, out.realmsStillHolding());
        assertFalse(out.orphanCountUnknown());
    }
}
