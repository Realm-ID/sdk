package dev.realmid.sdk.middleware;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.scope.ScopeFilter;
import dev.realmid.sdk.scope.ScopePolicy;
import dev.realmid.sdk.scope.ScopeRule;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Audit e-03 / e-04, sdk/SPEC.md SPEC11_4_1_canon (matcher) and
 * SPEC11_4_1_source (java: servlet path, 400 invalid_path). Runs every case of
 * sdk/testdata/path-match-vectors/vectors.json, asserts the declared counts.
 */
class PathMatchVectorsTest {

    private static final ObjectMapper M = new ObjectMapper();
    private static final Path FILE = Path.of("..", "testdata", "path-match-vectors", "vectors.json");

    private static dev.realmid.sdk.Realm realm() {
        return dev.realmid.sdk.Realm.builder().sessionStore(new dev.realmid.sdk.session.MemorySessionStore())
                .realmId("01HREALM").apiKey("rk").baseUrl("http://127.0.0.1:1").audience("acme.test").build();
    }

    @Test
    void sharedVectors() throws Exception {
        JsonNode v = M.readTree(Files.readAllBytes(FILE));
        int m = 0, r = 0, failed = 0;
        List<String> bad = new ArrayList<>();
        for (JsonNode c : v.get("matcher")) {
            m++;
            boolean got = GlobMatcher.canonicalMatch(c.get("pattern").asText(), c.get("kind").asText(), c.get("path").asText());
            if (got != c.get("match").asBoolean()) { failed++; bad.add(c.get("id").asText()); }
        }
        List<String> rules = new ArrayList<>();
        v.get("request_rules").get("mfa").forEach(n -> rules.add(n.asText()));
        for (JsonNode c : v.get("request")) {
            r++;
            JsonNode j = c.get("java");
            String pi = j.get("path_info").isNull() ? null : j.get("path_info").asText();
            RealmFilterTest.FakeReq req = new RealmFilterTest.FakeReq("GET",
                    j.get("request_uri").asText(), j.get("servlet_path").asText(), pi);
            String seen = GlobMatcher.requestPath(req);
            JsonNode want = c.get("java_expect");
            String wantSeen = want.get("seen").asText();
            String gotSeen = seen == null ? "400" : seen;
            String gotRule = null;
            if (seen != null) {
                for (String p : rules) {
                    if (GlobMatcher.canonicalMatch(p, "mfa", seen)) { gotRule = p; break; }
                }
            }
            String wantRule = want.get("mfa_rule").isNull() ? null : want.get("mfa_rule").asText();
            if (!wantSeen.equals(gotSeen) || !java.util.Objects.equals(wantRule, gotRule)) {
                failed++; bad.add(c.get("id").asText());
            }
        }
        System.out.println("path-match-vectors java: ran " + m + " matcher + " + r + " request cases, " + failed + " failed");
        assertEquals(v.get("matcher_case_count").asInt(), m);
        assertEquals(v.get("request_case_count").asInt(), r);
        assertTrue(m > 0 && r > 0);
        assertEquals(List.of(), bad, "failed vector ids");
    }

    @Test
    void realmFilterAnswers400BeforeAnyExemption() throws Exception {
        RealmFilter f = realm().middleware().exemptPaths(List.of("/public/**")).buildFilter();
        RealmFilterTest.FakeReq req = new RealmFilterTest.FakeReq("GET",
                "/public/../admin/users", "/admin/users", null);
        RealmFilterTest.FakeRes res = new RealmFilterTest.FakeRes();
        AtomicBoolean ran = new AtomicBoolean();
        f.doFilter(req, res, (a, b) -> ran.set(true));
        assertFalse(ran.get());
        assertEquals(400, res.status);
        Map<?, ?> body = M.readValue(res.bytes(), Map.class);
        assertEquals("invalid_path", ((Map<?, ?>) body.get("error")).get("code"));
        assertEquals("request path is not canonical", ((Map<?, ?>) body.get("error")).get("message"));
    }

    @Test
    void realmFilterExemptsOnServletPathNotRawUri() throws Exception {
        RealmFilter f = realm().middleware().exemptPaths(List.of("/health")).buildFilter();
        // context-path prefix: raw URI /myapp/health, servlet path /health -> exempt
        RealmFilterTest.FakeReq req = new RealmFilterTest.FakeReq("GET", "/myapp/health", "/health", null);
        AtomicBoolean ran = new AtomicBoolean();
        f.doFilter(req, new RealmFilterTest.FakeRes(), (a, b) -> ran.set(true));
        assertTrue(ran.get());
    }

    @Test
    void scopeFilterAnswers400() throws Exception {
        ScopeFilter f = new ScopeFilter(ScopePolicy.of(ScopeRule.requireAll("/**", "x")));
        RealmFilterTest.FakeReq req = new RealmFilterTest.FakeReq("GET", "/files/a%2Fb", "/files/a/b", null);
        RealmFilterTest.FakeRes res = new RealmFilterTest.FakeRes();
        f.doFilter(req, res, (a, b) -> { throw new AssertionError("chain must not run"); });
        assertEquals(400, res.status);
        assertTrue(new String(res.bytes()).contains("invalid_path"));
    }
}
