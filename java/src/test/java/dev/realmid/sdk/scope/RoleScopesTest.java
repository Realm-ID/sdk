package dev.realmid.sdk.scope;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** ADR-097 / ADR-100 D9 — the role -> scope map. */
class RoleScopesTest {

    private static final Map<String, List<String>> MAP = Map.of(
            "dispatcher", List.of("orders:read", "orders:assign"),
            "accountant", List.of("invoices:read", "orders:read"),
            "observer", List.of("orders:read"));

    /**
     * The output goes on the wire and into {@code rolePermissions}, so it must
     * be a SET — sorted and de-duplicated — not whatever order two maps
     * happened to iterate in. Two identical grants that serialise differently
     * are indistinguishable from two different grants in a log or a diff.
     */
    @Test
    void unionsSortsAndDeduplicates() {
        List<String> want = List.of("invoices:read", "orders:assign", "orders:read");
        assertEquals(want, RoleScopes.scopesForRoles(MAP, List.of("dispatcher", "accountant")));
        // Role order must not change the result either.
        assertEquals(want, RoleScopes.scopesForRoles(MAP, List.of("accountant", "dispatcher")));
    }

    /**
     * Fail-closed, and deliberately silent: a user holding a role the map does
     * not know gets fewer scopes and is refused at the gate. Throwing instead
     * would lock people out of the product over a config gap, which is what
     * {@link RoleScopes#validate} exists to catch at startup.
     */
    @Test
    void unknownRoleContributesNothing() {
        Map<String, List<String>> m = Map.of("known", List.of("a:read"));
        assertEquals(List.of(), RoleScopes.scopesForRoles(m, List.of("ghost")));
        assertEquals(List.of("a:read"), RoleScopes.scopesForRoles(m, List.of("known", "ghost")));
        assertEquals(List.of(), RoleScopes.scopesForRoles(MAP, List.of()));
        assertEquals(List.of(), RoleScopes.scopesForRoles(Map.of(), List.of("dispatcher")));
        assertEquals(List.of(), RoleScopes.scopesForRoles(null, List.of("dispatcher")));
    }

    /**
     * Each of these is a config error whose symptom appears at request time,
     * far from the typo.
     */
    @Test
    void validateCatchesTheGapsThatCostAuthority() {
        assertEquals(List.of(), RoleScopes.validate(Map.of("ok", List.of("orders:read"))));

        List<String> idle = RoleScopes.validate(Map.of("idle", List.of()));
        assertEquals(1, idle.size());
        assertTrue(idle.get(0).contains("maps to no scopes"), idle.get(0));

        List<String> bad = RoleScopes.validate(Map.of("bad", List.of("has space")));
        assertEquals(1, bad.size());
        assertTrue(bad.get(0).contains("not a legal RFC 6749 scope token"), bad.get(0));

        // Every message must name the map it is about, so an operator reading a
        // boot log knows which of the two scope maps to open.
        assertTrue(bad.get(0).startsWith("role scopes:"), bad.get(0));
    }

    /** Sorted, so a startup log line and a coverage assertion are stable. */
    @Test
    void roleNamesAreSorted() {
        assertEquals(List.of("alpha", "mike", "zulu"),
                RoleScopes.roleNames(Map.of("zulu", List.of("a"), "alpha", List.of("b"), "mike", List.of("c"))));
        assertEquals(List.of(), RoleScopes.roleNames(Map.of()));
    }
}
