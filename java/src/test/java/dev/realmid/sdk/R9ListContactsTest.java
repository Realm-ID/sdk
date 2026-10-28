package dev.realmid.sdk;

import dev.realmid.sdk.me.MeAuth;
import dev.realmid.sdk.me.MeContact;
import dev.realmid.sdk.pagination.Page;
import dev.realmid.sdk.pagination.PageOpts;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.http.HttpClient;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/** GET /me/contacts (issuer spec 0.63.0, build spec Revision 8). */
class R9ListContactsTest {
    private FakeServer fs;
    private Realm realm;

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

    @Test
    void listContactsDecodesTheEnvelopeAndStreamsAcrossPages() {
        fs.on("GET /me/contacts", (ex, b) -> {
            String q = ex.getRequestURI().getQuery();
            Map<String, Object> body = new HashMap<>();
            if (q != null && q.contains("cursor=n2")) {
                body.put("items", List.of(Map.of("id", "c-2", "kind", "email", "value", "a@b.c",
                        "verified", true, "tenant_id", "t-2")));
                body.put("next_cursor", null);
            } else {
                body.put("items", List.of(Map.of("id", "c-1", "kind", "phone", "value", "+15550100",
                        "verified", false, "tenant_id", "t-1")));
                body.put("next_cursor", "n2");
            }
            body.put("total", 2);
            return FakeServer.Reply.json(200, body);
        });
        Page<MeContact> first = realm.me().listContacts(MeAuth.onBehalfOf("user-jwt")).page(PageOpts.empty());
        assertEquals(new MeContact("c-1", "phone", "+15550100", false, "t-1"), first.items().get(0));
        assertEquals("n2", first.nextCursor());
        assertEquals("user-jwt", fs.last().header("x-user-token"));

        List<MeContact> all = realm.me().listContacts(MeAuth.onBehalfOf("user-jwt")).stream().toList();
        assertEquals(2, all.size());
        assertTrue(all.get(1).verified());
        assertEquals("t-2", all.get(1).tenantId());
    }
}
