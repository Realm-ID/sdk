package dev.realmid.sdk.tenants;

import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.http.HttpClient;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** ADR-080 Phase B — delink / hand-back / drift-reject-hard + contact_admin_required. */
class UserBindingClientTest {
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
    void delinkContactPostsRouteAndParsesResult() {
        fs.onJson("POST /tenants/t1/users/u1/contacts/c7/delink", (body, rec) -> {
            assertEquals("Bearer pt", rec.header("authorization"));
            return FakeServer.Reply.json(200, Map.of(
                    "status", "delinked", "contact_id", "c7", "revoked_bindings", 2));
        });
        DelinkContactResult r = realm.tenants().users().delinkContact("t1", "u1", "c7");
        assertEquals("delinked", r.status());
        assertEquals("c7", r.contactId());
        assertEquals(2L, r.revokedBindings());
    }

    @Test
    void handBackPostsFromUserIdAndParsesResult() {
        fs.onJson("POST /tenants/t1/users/uold/hand-back", (body, rec) -> {
            assertEquals("unew", body.get("from_user_id"));
            assertEquals("Bearer pt", rec.header("authorization"));
            return FakeServer.Reply.json(200, Map.of(
                    "status", "handed_back", "user_id", "uold", "email", "a@b.co"));
        });
        HandBackResult r = realm.tenants().users().handBack("t1", "uold", "unew");
        assertEquals("handed_back", r.status());
        assertEquals("uold", r.userId());
        assertEquals("a@b.co", r.email());
    }

    @Test
    void rejectSoftSendsNoBody() {
        fs.on("POST /tenants/t1/contact-drift-reviews/rev1/reject", (ex, body) -> {
            assertTrue(body == null || body.length == 0, "soft reject sends no body");
            return FakeServer.Reply.json(200, Map.of("id", "rev1", "status", "rejected", "mode", "soft"));
        });
        DriftRejectResult r = realm.tenants().driftReviews().reject("t1", "rev1");
        assertEquals("soft", r.mode());
        assertFalse(r.parked());
    }

    @Test
    void rejectHardSendsHardTrueAndParsesParked() {
        fs.onJson("POST /tenants/t1/contact-drift-reviews/rev1/reject", (body, rec) -> {
            assertEquals(Boolean.TRUE, body.get("hard"));
            return FakeServer.Reply.json(200, Map.of(
                    "id", "rev1", "status", "rejected", "mode", "hard", "parked", true, "revoked_bindings", 1));
        });
        DriftRejectResult r = realm.tenants().driftReviews().rejectHard("t1", "rev1");
        assertEquals("hard", r.mode());
        assertTrue(r.parked());
        assertEquals(1L, r.revokedBindings());
    }

    /**
     * The issuer's login 409 uses the FLAT envelope { "error": "<msg>", "code":
     * "contact_admin_required" } — `error` is a STRING. The decoder must read
     * the top-level `code` (and surface `error` as the message).
     */
    @Test
    void contactAdminRequiredDecodesFromFlatEnvelope() {
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("error", "this contact is managed — contact an admin");
        envelope.put("code", "contact_admin_required");
        // The platform-token bootstrap and the user login both hit POST
        // /auth/login (ADR-051), distinguished by grant_type — only fail the
        // user login, else the 409 would come from the token mint instead.
        fs.on("POST /auth/login", (ex, body) -> {
            Map<String, Object> b = fs.last().bodyAsMap();
            if ("platform_api_key".equals(b.get("grant_type"))) {
                return FakeServer.Reply.json(200, Map.of(
                        "access_token", "pt", "refresh_token", "rt",
                        "expires_in", 300, "subject_type", "platform"));
            }
            return FakeServer.Reply.json(409, envelope);
        });
        RealmException ex = assertThrows(RealmException.class,
                () -> realm.auth().login(new dev.realmid.sdk.auth.LoginRequest("microsoft", "tok", null)));
        assertEquals(ErrorCode.CONTACT_ADMIN_REQUIRED, ex.getCode());
        assertEquals(409, ex.getHttpStatus());
        assertEquals("this contact is managed — contact an admin", ex.getMessage());
        // `error` string is consumed as the message, not left as a stray detail.
        assertNull(ex.getDetails().get("error"));
    }
}
