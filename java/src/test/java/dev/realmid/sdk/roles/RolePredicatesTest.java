package dev.realmid.sdk.roles;

import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ADR-101 D6 (authority) + ADR-081 (principal typing), client side.
 *
 * <p>The issuer is authoritative — see {@link RolePredicates} — so nothing here
 * is a security control; it is the "do not OFFER a choice every save will 403"
 * contract. {@link RolePredicatesDriftTest} is the half that checks the copy
 * still matches its source.
 */
class RolePredicatesTest {

    private static RoleObject role(String name, List<String> perms, List<String> assignableTo) {
        RoleObject r = new RoleObject();
        r.setName(name);
        r.setPermissions(perms);
        r.setAssignableTo(assignableTo);
        return r;
    }

    // ── confersAuthority ─────────────────────────────────────────────────────

    /**
     * The rule is over the GRANTS, never the name. A role called `admin` with
     * no permissions confers nothing; a role called `reporting` that can revoke
     * sessions confers authority. Getting this backwards is the whole reason
     * ADR-101 D6 derives the predicate from the ADR-074 catalog.
     */
    @Test
    void authorityIsDerivedFromGrantsNotFromTheName() {
        assertFalse(RolePredicates.confersAuthority(role("admin", List.of(), List.of())));
        assertFalse(RolePredicates.confersAuthority(
                role("admin", List.of("users:read", "audit:read", "roles:read"), List.of())));
        assertTrue(RolePredicates.confersAuthority(
                role("reporting", List.of("audit:read", "sessions:revoke"), List.of())));
        assertTrue(RolePredicates.confersAuthority(
                role("member", List.of("users:manage"), List.of())));
    }

    /** Every non-`read` action qualifies, not just `manage`. */
    @Test
    void everyNonReadActionConfers() {
        for (String p : List.of("users:manage", "sessions:revoke", "signing_keys:rotate",
                "platform:config", "domains:manage")) {
            assertTrue(RolePredicates.confersAuthority(List.of(p)), p);
        }
        for (String p : List.of("users:read", "otp:read", "org_grants:read")) {
            assertFalse(RolePredicates.confersAuthority(List.of(p)), p);
        }
    }

    /**
     * FAIL CLOSED. An entry we cannot parse must never read as harmless: the
     * issuer classifies anything outside the catalog as mutating for exactly
     * this reason, and a colon-less legacy free-form string (ADR-074 § Storage)
     * is the concrete case.
     */
    @Test
    void malformedEntryFailsClosed() {
        assertTrue(RolePredicates.confersAuthority(List.of("manage_everything")));
        assertTrue(RolePredicates.confersAuthority(List.of("users:read", "legacy_grant")));
        assertTrue(RolePredicates.confersAuthority(Arrays.asList("users:read", (String) null)),
                "a null entry is unparseable, so it confers");
    }

    /**
     * A null role confers NOTHING — parity with the go/ts siblings. A caller
     * that could not resolve a role has a different problem to report, and
     * there are no grants to classify.
     */
    @Test
    void nullRoleConfersNothing() {
        assertFalse(RolePredicates.confersAuthority((RoleObject) null));
    }

    /**
     * Supplied with the realm's SERVED ADR-074 catalog
     * ({@code roles().listPermissions()}), classification matches the issuer
     * EXACTLY — including its fail-closed answer for a well-formed grant string
     * the catalog does not name, which string-parsing alone cannot give.
     */
    @Test
    void aSuppliedCatalogGivesTheIssuersExactAnswer() {
        List<Permission> catalog = List.of(
                new Permission("users:read", "users", "read", "View users"),
                new Permission("users:manage", "users", "manage", "Manage users"));

        assertFalse(RolePredicates.confersAuthority(List.of("users:read"), catalog));
        assertTrue(RolePredicates.confersAuthority(List.of("users:manage"), catalog));
        assertTrue(RolePredicates.confersAuthority(List.of("widgets:read"), catalog),
                "unknown to the catalog: fail closed, as realmrole.IsMutatingPermission does");
        // Without the catalog the same string is classified by its action.
        assertFalse(RolePredicates.confersAuthority(List.of("widgets:read")));
        // A null catalog is "I do not have one", i.e. parse mode.
        assertFalse(RolePredicates.confersAuthority(List.of("widgets:read"), null));
    }

    /**
     * An action containing a colon still resolves: the split is on the FIRST
     * colon, matching `resource:action` where the resource never contains one.
     */
    @Test
    void actionIsEverythingAfterTheFirstColon() {
        assertFalse(RolePredicates.confersAuthority(List.of("users:read")));
        assertTrue(RolePredicates.confersAuthority(List.of("a:b:read")),
                "action `b:read` is not `read`");
    }

    /** No grants at all is read-only, not unparseable. Empty entries are skipped. */
    @Test
    void emptyGrantsConferNothing() {
        assertFalse(RolePredicates.confersAuthority((List<String>) null));
        assertFalse(RolePredicates.confersAuthority(List.of()));
        assertFalse(RolePredicates.confersAuthority(List.of("", "  ")));
    }

    // ── isRoleAssignableTo ───────────────────────────────────────────────────

    /** The declared ADR-081 set is honoured in both directions. */
    @Test
    void declaredKindsAreHonoured() {
        RoleObject dispatch = role("dispatch", List.of("users:read"), List.of("service"));
        assertTrue(RolePredicates.isRoleAssignableTo(dispatch, RolePredicates.KIND_SERVICE));
        assertFalse(RolePredicates.isRoleAssignableTo(dispatch, RolePredicates.KIND_HUMAN));

        RoleObject both = role("support", List.of("users:read"), List.of("human", "service"));
        assertTrue(RolePredicates.isRoleAssignableTo(both, RolePredicates.KIND_HUMAN));
        assertTrue(RolePredicates.isRoleAssignableTo(both, RolePredicates.KIND_SERVICE));
    }

    /**
     * Empty/absent `assignable_to` means ANY — read-time fails OPEN. Since
     * ADR-081 § Amendment 2 the issuer never stores it empty, so this branch
     * only fires for a response from an issuer older than v0.57.0, and
     * degrading to pre-ADR-081 behaviour beats emptying every picker.
     */
    @Test
    void absentAssignableToMeansAny() {
        RoleObject old = role("legacy", List.of("users:read"), List.of());
        assertTrue(RolePredicates.isRoleAssignableTo(old, RolePredicates.KIND_HUMAN));
        assertTrue(RolePredicates.isRoleAssignableTo(old, RolePredicates.KIND_SERVICE));

        RoleObject nullSet = role("legacy", List.of("users:read"), null);
        assertTrue(RolePredicates.isRoleAssignableTo(nullSet, RolePredicates.KIND_HUMAN));
    }

    /**
     * ADR-081 §2.3 — a floor that holds regardless of what the role DECLARES:
     * each of these grants is a path by which a leaked machine credential
     * becomes realm control.
     */
    @Test
    void humanOnlyPermissionsBlockAServicePrincipal() {
        for (String p : RolePredicates.HUMAN_ONLY_PERMISSIONS) {
            RoleObject r = role("custom", List.of("users:read", p), List.of("human", "service"));
            assertFalse(RolePredicates.isRoleAssignableTo(r, RolePredicates.KIND_SERVICE), p);
            assertTrue(RolePredicates.isRoleAssignableTo(r, RolePredicates.KIND_HUMAN), p);
        }
    }

    /**
     * ADR-091 — the §2.3 floor applies to PARTNER-AUTHORED roles only. The
     * RI-managed bot roles are the realm's machine identity by construction and
     * are granted realm-control permissions on purpose; applying the floor to
     * them would make the bot role unassignable to the very bot it exists for.
     */
    @Test
    void systemRolesAreExemptFromTheHumanOnlyFloor() {
        RoleObject bot = role("ops_sync",
                List.of("platform:config"), List.of("service"));
        bot.setIsSystem(true);
        assertTrue(RolePredicates.isRoleAssignableTo(bot, RolePredicates.KIND_SERVICE));
    }

    /**
     * `owner` moves via the ADR-076 ownership pointer and `platform_api` backs
     * the ADR-041 API-key bot: neither is reachable on an assignment path, so
     * neither belongs in a picker.
     */
    @Test
    void systemUnassignableRolesAreNeverOffered() {
        for (String name : RolePredicates.SYSTEM_UNASSIGNABLE) {
            RoleObject r = role(name, List.of(), List.of("human", "service"));
            assertFalse(RolePredicates.isRoleAssignableTo(r, RolePredicates.KIND_HUMAN), name);
            assertFalse(RolePredicates.isRoleAssignableTo(r, RolePredicates.KIND_SERVICE), name);
        }
    }

    /** A soft-disabled role (roles overhaul) is refused on every path. */
    @Test
    void disabledRolesAreNotAssignable() {
        RoleObject r = role("support", List.of("users:read"), List.of("human", "service"));
        r.setDisabled(true);
        assertFalse(RolePredicates.isRoleAssignableTo(r, RolePredicates.KIND_HUMAN));
    }

    /** No role and no kind are both "nothing to offer", not "offer it". */
    @Test
    void nullsAreNotAssignable() {
        assertFalse(RolePredicates.isRoleAssignableTo(null, RolePredicates.KIND_HUMAN));
        assertFalse(RolePredicates.isRoleAssignableTo(
                role("support", List.of(), List.of("human")), null));
    }

    /**
     * ADR-101 removed `required_mfa_methods` from the role wire, so there is no
     * per-role MFA floor left to evaluate. A role carrying the field as an
     * unknown extra (an older issuer) must not resurrect the check.
     */
    @Test
    void noPerRoleMfaFloorIsEvaluated() {
        RoleObject r = role("support", List.of("users:read"), List.of("human", "service"));
        r.put("required_mfa_methods", List.of("totp"));
        assertTrue(RolePredicates.isRoleAssignableTo(r, RolePredicates.KIND_SERVICE));
    }
}
