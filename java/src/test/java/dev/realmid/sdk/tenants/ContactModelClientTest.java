package dev.realmid.sdk.tenants;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.http.HttpClient;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class ContactModelClientTest {
    private FakeServer fs;
    private Realm realm;

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        fs.on("POST /auth/platform-token", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("platform_token", "pt", "expires_in", 300)));
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
    void invitationCreateSendsIdentifierAndParsesNewShape() {
        fs.onJson("POST /tenants/t1/invitations", (body, rec) -> {
            assertEquals("+919999000011", body.get("identifier"));
            assertEquals("admin", body.get("role"));
            assertNull(body.get("email"));
            return FakeServer.Reply.json(200, Map.of(
                    "id", "u-stable",
                    "identifier", "+919999000011",
                    "role", "admin",
                    "status", "pending",
                    "expires_at", 1700000000));
        });
        Invitation inv = realm.tenants().invitations()
                .create("t1", InvitationCreate.of("+919999000011", "admin"));
        assertEquals("u-stable", inv.id());
        assertEquals("+919999000011", inv.identifier());
        assertEquals("admin", inv.role());
        assertEquals("pending", inv.status());
        assertEquals(1700000000L, inv.expiresAt());
    }

    @Test
    void updateContactSendsNonNullFields() {
        fs.onJson("PATCH /tenants/t1/users/u1", (body, rec) -> {
            assertEquals("new@acme.test", body.get("email"));
            assertNull(body.get("phone"));
            return FakeServer.Reply.json(200, Map.of(
                    "id", "u1", "email", "new@acme.test", "status", "active", "role", "member"));
        });
        User u = realm.tenants().users()
                .updateContact("t1", "u1", UpdateContactInput.ofEmail("new@acme.test"));
        assertEquals("u1", u.id());
        assertEquals("new@acme.test", u.email());
    }

    @Test
    void driftReviewListAndAccept() {
        fs.on("GET /tenants/t1/contact-drift-reviews", (ex, body) -> {
            java.util.Map<String, Object> page = new java.util.LinkedHashMap<>();
            page.put("items", List.of(Map.of(
                    "id", "dr1",
                    "contact_id", "c1",
                    "user_id", "u1",
                    "asserted_value", "alt@acme.test",
                    "asserted_method", "email",
                    "asserted_provider_uid", "google|123",
                    "seen_count", 3,
                    "first_seen_at", 1000,
                    "last_seen_at", 2000,
                    "status", "pending")));
            page.put("next_cursor", null);
            return FakeServer.Reply.json(200, page);
        });
        List<DriftReview> rows = realm.tenants().driftReviews().list("t1").stream().toList();
        assertEquals(1, rows.size());
        assertEquals("dr1", rows.get(0).id());
        assertEquals("alt@acme.test", rows.get(0).assertedValue());
        assertEquals(3, rows.get(0).seenCount());

        fs.on("POST /tenants/t1/contact-drift-reviews/dr1/accept", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                "id", "dr1", "status", "accepted", "accepted_value", "alt@acme.test", "new_contact_id", "c2")));
        DriftAcceptResult res = realm.tenants().driftReviews().accept("t1", "dr1");
        assertEquals("accepted", res.status());
        assertEquals("c2", res.newContactId());
    }

    @Test
    void contactVerificationApprove() {
        fs.on("POST /tenants/t1/contact-verifications/cv1/approve", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                "id", "cv1", "state", "active")));
        ContactVerificationResult res = realm.tenants().contactVerifications().approve("t1", "cv1");
        assertEquals("cv1", res.id());
        assertEquals("active", res.state());
    }
}
