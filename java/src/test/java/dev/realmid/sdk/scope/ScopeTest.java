package dev.realmid.sdk.scope;

import dev.realmid.sdk.Claims;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ADR-097 layers 1 and 2.
 *
 * <p>Two properties carry the design and are asserted directly rather than
 * implied by happy paths: the predicate FAILS CLOSED on every unanswerable
 * question, and a policy DENIES BY DEFAULT so that forgetting to declare a route
 * produces a locked door rather than an open one.
 */
class ScopeTest {

    private static Claims claimsWithScope(Object scope) {
        Map<String, Object> extra = new LinkedHashMap<>();
        if (scope != null) extra.put("scope", scope);
        return new Claims("https://auth.realmid.dev/r1", "u1", "realmid:plt_x",
                1L, 1L, 9999999999L, "jti", "azp", "t1", "member", extra);
    }

    @Test
    void scopeAllowsFailsClosed() {
        Claims full = claimsWithScope("a b c");

        assertFalse(Scopes.scopeAllows(null, List.of("a")), "null claims");
        assertFalse(Scopes.scopeAllows(claimsWithScope(null), List.of("a")), "no scope claim");
        assertFalse(Scopes.scopeAllows(claimsWithScope(""), List.of("a")), "empty scope claim");
        assertFalse(Scopes.scopeAllows(claimsWithScope("   "), List.of("a")), "whitespace-only");

        // The one worth arguing about: an EMPTY requirement is FALSE, not
        // vacuously true. Vacuous-true is how a gate silently stops gating — a
        // route someone forgot to configure would pass every caller — and a
        // genuinely public route is DECLARED, not inferred.
        assertFalse(Scopes.scopeAllows(full, List.of()), "empty required is not vacuously true");
        assertFalse(Scopes.scopeAllows(full, null), "null required is not vacuously true");

        assertTrue(Scopes.scopeAllows(full, List.of("b")));
        assertTrue(Scopes.scopeAllows(full, List.of("a", "c")));
        assertFalse(Scopes.scopeAllows(full, List.of("a", "z")), "all-of, one missing");

        // No pattern matching — the same rule capAllows states, for the same
        // reason: RealmID does not interpret a partner's vocabulary.
        assertFalse(Scopes.scopeAllows(claimsWithScope("read"), List.of("read:orders")), "no prefix implication");
        assertFalse(Scopes.scopeAllows(claimsWithScope("read:orders"), List.of("read")), "no suffix implication");
        assertFalse(Scopes.scopeAllows(claimsWithScope("*"), List.of("anything")), "no wildcard expansion");
        assertFalse(Scopes.scopeAllows(claimsWithScope("read"), List.of("Read")), "case-sensitive");

        // RFC 9068 §2.2.3 makes this claim a STRING. Quietly accepting a List
        // would mask a wire mismatch that ought to be loud.
        assertFalse(Scopes.scopeAllows(claimsWithScope(List.of("a")), List.of("a")), "array-shaped claim");
    }

    @Test
    void anyOfDiffersFromAllOf() {
        Claims c = claimsWithScope("a b");
        assertTrue(Scopes.scopeAllowsAny(c, List.of("z", "b")));
        assertFalse(Scopes.scopeAllowsAny(c, List.of("y", "z")));
        assertFalse(Scopes.scopeAllowsAny(c, List.of()), "empty required is not vacuously true");
        assertFalse(Scopes.scopeAllowsAny(null, List.of("a")));
        // If these ever agree on a partially-held set, one of them is decoration.
        assertNotEquals(Scopes.scopeAllows(c, List.of("a", "z")),
                Scopes.scopeAllowsAny(c, List.of("a", "z")));
    }

    @Test
    void scopesFromPreservesIssuerOrder() {
        assertEquals(List.of("c", "a", "b"), Scopes.scopesFrom(claimsWithScope("c  a   b")));
        assertEquals(List.of(), Scopes.scopesFrom(null));
        assertEquals(List.of(), Scopes.scopesFrom(claimsWithScope(List.of("a"))));
    }

    @Test
    void policyDeniesByDefault() {
        ScopePolicy p = ScopePolicy.of(ScopeRule.requireAll("/orders/**", "orders:read"));
        Claims c = claimsWithScope("orders:read admin");

        // PRECONDITION: the DECLARED route is allowed, so the denial below is
        // attributable to the missing declaration and not to a broken policy.
        assertTrue(p.decide(c, "GET", "/orders/42").allowed(),
                "PRECONDITION: the declared route must be allowed");

        ScopeDecision d = p.decide(c, "GET", "/invoices/42");
        assertFalse(d.allowed(), "an UNDECLARED route must be denied, even to a token holding every scope");
        assertFalse(d.matched(), "matched=false lets a caller tell a config gap from an authz failure");
    }

    @Test
    void publicAnyOfMethodAndFirstMatchWins() {
        ScopePolicy p = ScopePolicy.of(
                ScopeRule.publicRoute("/health"),
                ScopeRule.requireAll("/orders/*/export", "orders:export"),
                ScopeRule.requireAll("/orders/**", "orders:read").onMethod("GET"),
                ScopeRule.requireAll("/orders/**", "orders:write", "orders:read"),
                ScopeRule.requireAny("/reports/**", "r:a", "r:b"));

        assertTrue(p.decide(null, "GET", "/health").allowed(),
                "a public route must allow a request with no claims at all");

        Claims read = claimsWithScope("orders:read");
        assertTrue(p.decide(read, "GET", "/orders/7").allowed());
        assertFalse(p.decide(read, "POST", "/orders/7").allowed(), "POST falls through to the write rule");

        // /orders/7/export matches BOTH the export rule and the GET rule; the
        // export rule is first, so it decides.
        ScopeDecision exp = p.decide(read, "GET", "/orders/7/export");
        assertFalse(exp.allowed(), "the earlier, more specific rule must decide");
        assertEquals(List.of("orders:export"), exp.required());

        assertTrue(p.decide(claimsWithScope("r:a"), "GET", "/reports/x").allowed(), "anyOf on one of two");

        assertEquals(List.of("orders:write"), p.decide(read, "POST", "/orders/7").missing());
        assertEquals(List.of(), p.decide(claimsWithScope("nope"), "GET", "/reports/x").missing(),
                "an anyOf denial has no single missing scope");
    }

    @Test
    void validateReportsEveryProblemNotTheFirst() {
        List<String> errs = new ScopePolicy(List.of(
                ScopeRule.requireAll("", "a"),
                ScopeRule.requireAll("/b"),
                ScopeRule.requireAll("/c", "has space"),
                ScopeRule.requireAll("/ok", "fine"))).validate();
        assertEquals(3, errs.size(), "want 3 errors (empty path, no-scopes-not-public, bad charset), got " + errs);
        assertEquals(List.of(), ScopePolicy.of(ScopeRule.requireAll("/ok", "fine")).validate());
    }

    /**
     * The fourth error the Go and TypeScript validators report — a rule that is
     * both public and carries scopes — is UNREPRESENTABLE here, and that is a
     * property worth pinning rather than a gap.
     *
     * <p>{@link ScopeRule}'s factories are the only way to build one:
     * {@code publicRoute} takes no scopes and {@code requireAll}/{@code requireAny}
     * cannot set the public flag. So the mistake is a compile error in Java where
     * it is a startup diagnostic elsewhere — strictly better, and the reason the
     * validator's branch for it is belt-and-braces rather than load-bearing.
     *
     * <p>If a constructor is ever widened to allow the combination, this test
     * fails and the validator becomes load-bearing at runtime. That is the signal
     * it exists to give.
     */
    @Test
    void publicRuleCannotAlsoCarryScopes() {
        ScopeRule pub = ScopeRule.publicRoute("/health");
        assertTrue(pub.isPublic());
        assertEquals(List.of(), pub.scopes(),
                "publicRoute must not be able to carry scopes; if it can, the validator's "
                        + "public-with-scopes branch stops being belt-and-braces");
        assertFalse(ScopeRule.requireAll("/x", "a").isPublic(),
                "requireAll must not be able to produce a public rule");
        assertFalse(ScopeRule.requireAny("/x", "a").isPublic(),
                "requireAny must not be able to produce a public rule");
        assertEquals(List.of(), ScopePolicy.of(pub).validate(),
                "a public rule built through the factory is valid");
    }

    @Test
    void rfc6749Charset() {
        for (String ok : List.of("read", "write:orders", "a", "!", "~", "#", "[", "]", "UPPER", "9")) {
            assertTrue(Scopes.isRfc6749ScopeToken(ok), ok);
        }
        for (String bad : List.of("", "has space", "say\"what", "back\\slash", "tab\there", "café")) {
            assertFalse(Scopes.isRfc6749ScopeToken(bad), bad);
        }
    }

}
