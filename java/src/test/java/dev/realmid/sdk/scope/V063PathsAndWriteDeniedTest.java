package dev.realmid.sdk.scope;

import dev.realmid.sdk.Claims;
import dev.realmid.sdk.middleware.GlobMatcher;
import dev.realmid.sdk.middleware.MFARule;
import dev.realmid.sdk.middleware.RealmFilter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletOutputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.Test;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** SDK v0.63.0: SPEC10_2_paths, SPEC11_4 / SPEC11_4_1 / SPEC11_5_1. */
class V063PathsAndWriteDeniedTest {

    private static Claims claims(String scope) {
        return new Claims("https://auth.realmid.dev/r1", "u1", "aud", 1L, 1L, 9999999999L, "jti", "azp", "t1",
                "member", scope == null ? Map.of() : Map.of("scope", scope));
    }

    // ---- 68-70: /x/** matches bare /x ----

    @Test
    void SPEC10_2_doubleStarMatchesBarePrefix() {
        for (String p : new String[]{"/x", "/x/", "/x/a/b"}) {
            assertTrue(GlobMatcher.match("/x/**", p), p);
        }
        assertFalse(GlobMatcher.match("/x/**", "/xy"));
        assertTrue(GlobMatcher.matchPlaceholders("/x/**", "/x"));
        // ScopeRule path
        ScopePolicy pol = ScopePolicy.of(ScopeRule.requireAll("/x/**", "a"));
        assertTrue(pol.decide(claims("a"), "GET", "/x").allowed());
    }

    // ---- 71 / 75: {name} grammar ----

    @Test
    void SPEC11_4_1_placeholderMatchesOneNonEmptySegment() {
        assertTrue(GlobMatcher.matchPlaceholders("/orders/{id}", "/orders/42"));
        assertFalse(GlobMatcher.matchPlaceholders("/orders/{id}", "/orders/42/"));
        assertFalse(GlobMatcher.matchPlaceholders("/orders/{id}", "/orders/"));
        assertFalse(GlobMatcher.matchPlaceholders("/orders/{id}", "/orders"));
        assertFalse(GlobMatcher.matchPlaceholders("/orders/{id}", "/orders//42"));
        assertFalse(GlobMatcher.matchPlaceholders("/orders/{id}", "/orders/42/items"));
        assertTrue(GlobMatcher.matchPlaceholders("/orders/*", "/orders/"));
        assertFalse(GlobMatcher.matchPlaceholders("/orders/*", "/orders//42"));
        assertTrue(GlobMatcher.matchPlaceholders("/orders/**", "/orders/42/"));
        assertTrue(GlobMatcher.matchPlaceholders("/orders/**", "/orders"));
        assertTrue(GlobMatcher.matchPlaceholders("/orders/{id}/", "/orders/42/"));
        assertTrue(GlobMatcher.matchPlaceholders("/{id}/{id}", "/a/b"));
        assertTrue(GlobMatcher.matchPlaceholders("/orgs/{org}/files/**", "/orgs/o1/files/a/b"));
    }

    @Test
    void SPEC11_4_1_invalidBraceFormsAreInertAndReported() {
        String[][] cases = {
                {"/files/{path:.*}", "regex placeholders are unsupported"},
                {"/a/{}", "empty placeholder"},
                {"/a/{org id}", "name may contain only letters, digits"},
                {"/v{n}/x", "a placeholder must be a whole path segment"},
                {"/files/{id}.json", "a placeholder must be a whole path segment"},
                {"/{a}{b}", "a placeholder must be a whole path segment"},
                {"/a/{id", "unbalanced brace"},
                {"/a/id}", "unbalanced brace"},
                {"/a/{{id}}", "unbalanced brace"},
        };
        for (String[] c : cases) {
            String err = GlobMatcher.validateBraces(c[0]);
            assertTrue(err != null && err.contains(c[1]), c[0] + " -> " + err);
            assertFalse(GlobMatcher.matchPlaceholders(c[0], c[0]), "inert, never literal: " + c[0]);
            ScopePolicy p = ScopePolicy.of(ScopeRule.requireAll(c[0], "a"));
            List<String> errs = p.validate();
            assertTrue(errs.stream().anyMatch(e -> e.contains(c[1]) && e.contains(c[0]) && e.contains("0")),
                    c[0] + " validate -> " + errs);
            assertFalse(p.decide(claims("a"), "GET", c[0]).matched());
        }
        assertEquals(null, GlobMatcher.validateBraces("/orders/{id}"));
    }

    @Test
    void SPEC11_4_1_firstMatchWinsLiteralBeforePlaceholder() {
        ScopePolicy p = ScopePolicy.of(
                ScopeRule.requireAll("/orders/export", "orders:export").onMethod("GET"),
                ScopeRule.requireAll("/orders/{id}", "orders:read").onMethod("GET"));
        assertTrue(p.decide(claims("orders:export"), "GET", "/orders/export").allowed());
        assertTrue(p.decide(claims("orders:read"), "GET", "/orders/42").allowed());
        assertFalse(p.decide(claims("orders:read"), "GET", "/orders/export").allowed());
    }

    // ---- 72: exemptPaths keeps braces literal; 71/73 mfaProtectedPaths ----

    @Test
    void SPEC10_2_exemptBracesAreLiteral() {
        assertTrue(GlobMatcher.match("/hooks/{id}", "/hooks/{id}"));
        assertFalse(GlobMatcher.match("/hooks/{id}", "/hooks/abc"));
    }

    // ---- 74: missing on any-of ----

    @Test
    void SPEC11_4_anyOfDenialReportsFullScopesInDeclaredOrder() {
        ScopePolicy p = ScopePolicy.of(ScopeRule.requireAny("/r/**", "r:b", "r:a"),
                ScopeRule.requireAll("/w/**", "w:2", "w:1", "w:3"));
        ScopeDecision d = p.decide(claims("zzz"), "GET", "/r/x");
        assertFalse(d.allowed());
        assertEquals(List.of("r:b", "r:a"), d.missing());
        assertEquals(List.of("w:2", "w:3"), p.decide(claims("w:1"), "GET", "/w/x").missing());
        assertEquals(List.of(), p.decide(claims("r:a"), "GET", "/r/x").missing());
        assertEquals(List.of(), p.decide(claims("a"), "GET", "/none").missing());
    }

    // ---- 76: writeDenied ----

    private record Out(StringWriter body, List<Integer> status, List<String> events, AtomicBoolean ran) {}

    private Out run(ScopeFilter f, String path) throws Exception {
        StringWriter sw = new StringWriter();
        List<Integer> status = new ArrayList<>();
        List<String> events = new ArrayList<>();
        AtomicBoolean ran = new AtomicBoolean();
        HttpServletRequest req = (HttpServletRequest) Proxy.newProxyInstance(getClass().getClassLoader(),
                new Class<?>[]{HttpServletRequest.class}, (px, m, a) -> switch (m.getName()) {
                    case "getAttribute" -> RealmFilter.CLAIMS_ATTR.equals(a[0]) ? claims("other") : null;
                    case "getMethod" -> "GET";
                    case "getRequestURI" -> path;
                    default -> null;
                });
        HttpServletResponse res = (HttpServletResponse) Proxy.newProxyInstance(getClass().getClassLoader(),
                new Class<?>[]{HttpServletResponse.class}, (px, m, a) -> switch (m.getName()) {
                    case "setStatus" -> { status.add((Integer) a[0]); events.add("status"); yield null; }
                    case "setContentType" -> { events.add("ctype:" + a[0]); yield null; }
                    case "getWriter" -> new PrintWriter(sw, true);
                    default -> null;
                });
        FilterChain chain = (rq, rs) -> ran.set(true);
        f.doFilter(req, res, chain);
        return new Out(sw, status, events, ran);
    }

    @Test
    void SPEC11_5_1_unsetWriterIsByteIdenticalGolden403() throws Exception {
        ScopePolicy p = ScopePolicy.of(ScopeRule.requireAll("/p/**", "need"));
        Out o = run(new ScopeFilter(p), "/p/x");
        assertEquals("{\"error\":{\"code\":\"insufficient_scope\",\"message\":"
                + "\"this token does not carry the scope required for this route\"}}", o.body().toString());
        assertEquals(List.of(403), o.status());
        assertTrue(o.events().contains("ctype:application/json"));
        assertFalse(o.ran().get());
    }

    @Test
    void SPEC11_5_1_writerRunsAfterOnDeniedOnEveryDenial() throws Exception {
        ScopePolicy p = ScopePolicy.of(ScopeRule.requireAll("/p/**", "need"));
        List<String> order = new ArrayList<>();
        ScopeDeniedWriter w = (rq, rs, d) -> {
            order.add("write:" + d.matched() + ":" + d.missing());
            rs.getWriter().write("custom");
        };
        ScopeFilter f = new ScopeFilter(p, (rq, d) -> order.add("denied"), w);
        Out o = run(f, "/p/x");
        assertEquals(List.of("denied", "write:true:[need]"), order);
        assertEquals("custom", o.body().toString());
        assertEquals(List.of(403), o.status());
        assertFalse(o.events().contains("ctype:application/json"), "hook mode sets no content type");
        // default-deny (matched=false) also reaches the writer; null policy too
        order.clear();
        run(f, "/undeclared");
        assertEquals(List.of("denied", "write:false:[]"), order);
        order.clear();
        run(new ScopeFilter(null, (rq, d) -> order.add("denied"), w), "/p/x");
        assertEquals(List.of("denied", "write:false:[]"), order);
        // allowed request never reaches the writer
        order.clear();
        ScopeFilter open = new ScopeFilter(ScopePolicy.of(ScopeRule.publicRoute("/pub")), null, w);
        Out ok = run(open, "/pub");
        assertTrue(ok.ran().get());
        assertTrue(order.isEmpty());
    }

    @Test
    void SPEC10_2_mfaProtectedBraceFormsRefusedAtConstruction() {
        assertThrows(IllegalArgumentException.class, () -> MFARule.of("/a/{path:.*}"));
        assertThrows(IllegalArgumentException.class, () -> MFARule.of("/v{n}/x"));
        MFARule.of("/orders/{id}"); // valid
        assertTrue(GlobMatcher.matchPlaceholders(MFARule.of("/orders/{id}").path(), "/orders/42"));
    }
}
