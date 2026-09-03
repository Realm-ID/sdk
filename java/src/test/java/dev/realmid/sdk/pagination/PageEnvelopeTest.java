package dev.realmid.sdk.pagination;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.apikeys.APIKey;
import dev.realmid.sdk.serviceaccounts.ServiceAccount;
import dev.realmid.sdk.sources.Source;
import dev.realmid.sdk.userapikeys.UserAPIKey;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.http.HttpClient;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * The pagination envelope must survive a ROUND TRIP, and every list method must
 * hand it to the caller.
 *
 * <p>A decode-only assertion ("the field arrived") passes whether or not the
 * field is carried onward. That is not hypothetical: {@code go/v0.53.0} deleted
 * {@code credential_methods} from discovery because the BFF decoded an SDK type
 * and RE-SERIALISED it, and every layer's own suite stayed green because
 * nothing spanned the round trip.
 */
class PageEnvelopeTest {

    private final ObjectMapper mapper = new ObjectMapper();
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
    void envelopeSurvivesDecodeThenReEncode() throws Exception {
        String wire = "{\"items\":[{\"id\":\"a\"}],\"next_cursor\":\"cur-2\","
                + "\"has_more\":true,\"total\":97}";
        JsonNode raw = mapper.readTree(wire);
        Page<JsonNode> page = PageReader.read(raw, n -> n);

        assertEquals("cur-2", page.nextCursor());
        assertTrue(page.hasMore());
        assertEquals(97L, page.total());

        // Compare through actual JSON TEXT, not two in-memory trees: Jackson
        // distinguishes IntNode from LongNode, which is a decoding artefact and
        // not a wire difference. Re-parsing both sides asserts the thing that
        // matters — the bytes a consumer would re-emit.
        JsonNode back = PageWriter.write(mapper, page, n -> n);
        assertEquals(mapper.readTree(wire), mapper.readTree(back.toString()),
                "re-encoded envelope lost a field on the way OUT");
    }

    @Test
    void hasMoreFalseReEncodesAsAnExplicitFalse() throws Exception {
        JsonNode raw = mapper.readTree("{\"items\":[],\"next_cursor\":null,\"has_more\":false}");
        Page<JsonNode> page = PageReader.read(raw, n -> n);
        assertFalse(page.hasMore());

        JsonNode back = PageWriter.write(mapper, page, n -> n);
        assertTrue(back.has("has_more"), "re-encoded envelope dropped has_more entirely");
        assertFalse(back.get("has_more").asBoolean());
        assertTrue(back.get("next_cursor").isNull());
    }

    @Test
    void absentHasMoreIsDerivedFromCursorNeverReadAsFalse() throws Exception {
        Page<JsonNode> withCursor = PageReader.read(
                mapper.readTree("{\"items\":[],\"next_cursor\":\"c\"}"), n -> n);
        assertTrue(withCursor.hasMore(), "a pre-has_more endpoint with a cursor HAS more");

        Page<JsonNode> lastPage = PageReader.read(
                mapper.readTree("{\"items\":[],\"next_cursor\":null}"), n -> n);
        assertFalse(lastPage.hasMore());
    }

    // --- the four list methods that used to discard the envelope -------------

    private static Map<String, Object> page1(Object item) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("items", List.of(item));
        m.put("next_cursor", "cur-2");
        m.put("has_more", true);
        m.put("total", 3);
        return m;
    }

    private static Map<String, Object> page2(Object item) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("items", List.of(item));
        m.put("next_cursor", null);
        m.put("has_more", false);
        m.put("total", 3);
        return m;
    }

    /** Answers {@code route} with page one, then page two once ?cursor=cur-2 arrives. */
    private void twoPages(String route, Object first, Object second) {
        fs.on(route, (ex, body) -> {
            String q = ex.getRequestURI().getRawQuery();
            boolean second_ = q != null && q.contains("cursor=cur-2");
            return FakeServer.Reply.json(200, second_ ? page2(second) : page1(first));
        });
    }

    @Test
    void sourcesListExposesTheEnvelopeAndWalksEveryPage() {
        twoPages("GET /sources",
                Map.of("id", "s1", "platform_id", "01HREALM", "type", "web", "label", "one",
                        "allowed_methods", List.of("google"), "enabled", true, "created_at", 1),
                Map.of("id", "s2", "platform_id", "01HREALM", "type", "web", "label", "two",
                        "allowed_methods", List.of("google"), "enabled", true, "created_at", 2));

        Paginated<Source> list = realm.sources().list();
        Page<Source> page = list.page(PageOpts.empty());
        assertEquals("cur-2", page.nextCursor());
        assertTrue(page.hasMore(), "envelope discarded — caller cannot detect truncation");
        assertEquals(3L, page.total());

        List<String> ids = new ArrayList<>();
        list.stream().forEach(s -> ids.add(s.id()));
        assertEquals(List.of("s1", "s2"), ids, "pager stopped at page one");
    }

    @Test
    void serviceAccountsListExposesTheEnvelopeAndWalksEveryPage() {
        twoPages("GET /tenants/t1/service-accounts",
                Map.of("id", "sa1", "handle", "a@x.test", "role", "member",
                        "status", "active", "kind", "service"),
                Map.of("id", "sa2", "handle", "b@x.test", "role", "member",
                        "status", "active", "kind", "service"));

        Paginated<ServiceAccount> list = realm.serviceAccounts().list("t1");
        assertTrue(list.page(PageOpts.empty()).hasMore(), "envelope discarded");

        List<String> ids = new ArrayList<>();
        list.stream().forEach(a -> ids.add(a.id()));
        assertEquals(List.of("sa1", "sa2"), ids);
    }

    @Test
    void userApiKeysListExposesTheEnvelopeAndWalksEveryPage() {
        twoPages("GET /tenants/t1/users/u1/user-api-keys",
                Map.of("id", "k1", "prefix", "uk_live_a", "label", "one"),
                Map.of("id", "k2", "prefix", "uk_live_b", "label", "two"));

        Paginated<UserAPIKey> list = realm.userApiKeys().list("t1", "u1");
        Page<UserAPIKey> page = list.page(PageOpts.withLimit(1));
        assertTrue(page.hasMore(), "envelope discarded");
        assertNotNull(page.nextCursor());

        List<String> ids = new ArrayList<>();
        list.stream().forEach(k -> ids.add(k.id()));
        assertEquals(List.of("k1", "k2"), ids);
    }

    @Test
    void apiKeysListExposesTheEnvelopeAndWalksEveryPage() {
        twoPages("GET /platforms/01HREALM/api-keys",
                Map.of("id", "ak1", "prefix", "rk_live_a"),
                Map.of("id", "ak2", "prefix", "rk_live_b"));

        Paginated<APIKey> list = realm.apiKeys().list();
        assertTrue(list.page(PageOpts.empty()).hasMore(), "envelope discarded");

        List<String> ids = new ArrayList<>();
        list.stream().forEach(k -> ids.add(k.id()));
        assertEquals(List.of("ak1", "ak2"), ids);
    }

    @Test
    void pagerStopsOnHasMoreFalseEvenWithANonEmptyCursor() {
        AtomicInteger calls = new AtomicInteger();
        fs.on("GET /sources", (ex, body) -> {
            calls.incrementAndGet();
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("items", List.of(Map.of("id", "s1", "platform_id", "01HREALM", "type", "web",
                    "label", "one", "allowed_methods", List.of("google"),
                    "enabled", true, "created_at", 1)));
            m.put("next_cursor", "cur-9");
            m.put("has_more", false);
            return FakeServer.Reply.json(200, m);
        });

        long n = realm.sources().list().stream().limit(5).count();
        assertEquals(1L, n);
        assertEquals(1, calls.get(),
                "has_more:false is the terminator, not next_cursor");
    }

    // --- the serialised query string, not the intent of the code ------------
    //
    // The issuer now answers 400 invalid_limit to `limit=0` and 400
    // invalid_cursor to a malformed cursor, where both were previously absorbed
    // into the defaults. An UNSET limit must therefore be ABSENT from the URL,
    // not sent as `limit=0` — otherwise every list call 400s against a real
    // server while passing every unit test here. A value-level assertion cannot
    // see that; this reads the raw query.

    @Test
    void unsetLimitAndCursorAreOmittedFromTheQuery() {
        Map<String, String> seen = new LinkedHashMap<>();
        for (String route : List.of(
                "GET /sources",
                "GET /tenants/t1/service-accounts",
                "GET /tenants/t1/users/u1/user-api-keys",
                "GET /platforms/01HREALM/api-keys")) {
            fs.on(route, (ex, body) -> {
                seen.put(ex.getRequestURI().getPath(),
                        ex.getRequestURI().getRawQuery() == null ? "" : ex.getRequestURI().getRawQuery());
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("items", List.of());
                m.put("next_cursor", null);
                m.put("has_more", false);
                return FakeServer.Reply.json(200, m);
            });
        }

        realm.sources().list().page(PageOpts.empty());
        realm.serviceAccounts().list("t1").page(PageOpts.empty());
        realm.userApiKeys().list("t1", "u1").page(PageOpts.empty());
        realm.apiKeys().list().page(PageOpts.empty());

        assertEquals(4, seen.size(), "all four paged lists must have been called");
        for (Map.Entry<String, String> e : seen.entrySet()) {
            assertFalse(e.getValue().contains("limit="),
                    e.getKey() + " query \"" + e.getValue() + "\" sends limit — an unset limit must be absent");
            assertFalse(e.getValue().contains("cursor="),
                    e.getKey() + " query \"" + e.getValue() + "\" sends cursor — an unset cursor must be absent");
        }
        // The sources call carries its own required param, so the assertions
        // above are not passing merely because no query was built at all.
        assertTrue(seen.get("/sources").contains("platform_id=01HREALM"),
                "expected platform_id on /sources, so this test is not vacuous");
    }

    @Test
    void aSetLimitAndCursorAreSent() {
        StringBuilder q = new StringBuilder();
        fs.on("GET /platforms/01HREALM/api-keys", (ex, body) -> {
            q.setLength(0);
            q.append(ex.getRequestURI().getRawQuery());
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("items", List.of());
            m.put("next_cursor", null);
            m.put("has_more", false);
            return FakeServer.Reply.json(200, m);
        });
        realm.apiKeys().list().page(new PageOpts("c1", 25));
        assertTrue(q.toString().contains("limit=25"), q.toString());
        assertTrue(q.toString().contains("cursor=c1"), q.toString());
    }

    // --- pagination input errors reach the ErrorCode -------------------------
    //
    // The caller-visible claim, not the enum entry: a 400 invalid_limit /
    // invalid_cursor must surface as that code so a caller can BRANCH on it.
    // The Go twin of this test exists because go/v0.52.0 shipped four codes
    // missing from its taxonomy and they collapsed to a bare bad_request.

    @Test
    void paginationInputErrorsReachTheErrorCode() {
        for (String[] tc : List.of(
                new String[]{"invalid_limit", ErrorCode.INVALID_LIMIT.name()},
                new String[]{"invalid_cursor", ErrorCode.INVALID_CURSOR.name()})) {
            fs.on("GET /sources", (ex, body) -> FakeServer.Reply.json(400,
                    Map.of("error", "bad pagination input", "code", tc[0])));
            RealmException e = assertThrows(RealmException.class,
                    () -> realm.sources().list().page(PageOpts.empty()));
            assertEquals(tc[1], e.getCode().name(),
                    "code " + tc[0] + " must reach ErrorCode, not collapse to BAD_REQUEST");
        }
    }
}
