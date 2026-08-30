package dev.realmid.sdk.roles;

import java.util.List;
import java.util.Set;

/**
 * The two role predicates every admin console has to re-derive: does a role
 * CONFER AUTHORITY (ADR-101 D6), and may a principal of a given kind HOLD it
 * (ADR-081).
 *
 * <h2>The issuer wins</h2>
 *
 * <p>Nothing here is a security control. The issuer enforces both rules on
 * every assignment path and answers {@code 403 role_owner_only} /
 * {@code 400 role_not_assignable_to_kind}; this class exists so your console
 * never OFFERS a choice the server will refuse — the bug class ADR-090 /
 * issuer&nbsp;v0.84.0 documents, where a picker showed roles whose every save
 * came back a 403.
 *
 * <p>These are a copy of rules the issuer owns, so if the two ever disagree,
 * <b>the issuer wins and this file is the thing to fix</b>. The authoritative
 * sources are:
 *
 * <ul>
 *   <li>{@code issuer/internal/realmrole/permissions.go} — {@code ConfersAuthority}
 *       / {@code IsMutatingPermission}
 *   <li>{@code issuer/internal/realmrole/assignable.go} — {@code AssignableToKind},
 *       {@code HumanOnlyPermissions}
 *   <li>{@code issuer/internal/httpapi/role_assignable.go} — {@code requireRoleAssignableToKind}
 * </ul>
 *
 * <p>{@code RolePredicatesDriftTest} reads those files and fails when the copy
 * has drifted. A hand-maintained mirror with nothing checking it is precisely
 * how the {@code required_mfa_methods} check outlived the field it read.
 *
 * <p><b>No per-role MFA floor.</b> ADR-101 removed {@code required_mfa_methods}
 * from the role wire along with the column behind it, so there is no role-level
 * MFA requirement to evaluate. The per-realm and per-tenant MFA policies are
 * untouched and are not this class's business.
 */
public final class RolePredicates {

    private RolePredicates() {}

    /** A {@code users.kind} value (ADR-071) — a person. */
    public static final String KIND_HUMAN = "human";

    /** A {@code users.kind} value (ADR-071) — a service account. */
    public static final String KIND_SERVICE = "service";

    /**
     * Roles the issuer never accepts on an assignment path because they are
     * SYSTEM rows, independent of permissions: {@code owner} moves via the
     * ADR-076 ownership pointer, {@code platform_api} backs the ADR-041 API-key
     * bot, and {@code platform_mgmt_api} is the only identity permitted to mint
     * {@code platform_api}'s key (ADR-091 D3) — a human holding it would be a
     * credential-issuance path outside the owner pointer, which is exactly what
     * ADR-101 D6 closes.
     *
     * <p>Mirrors {@code realmrole.NonAssignableRoles}; the drift test compares
     * the two. The issuer refuses these on the specific ENDPOINTS rather than
     * inside {@code requireRoleAssignableToKind}, so this is a console-side
     * guard folded into the same predicate.
     */
    public static final Set<String> SYSTEM_UNASSIGNABLE =
            Set.of("owner", "platform_api", "platform_mgmt_api");

    /**
     * ADR-081 §2.3 — grants that require a human in the loop, because each is a
     * path by which a leaked machine credential escalates to realm control.
     * Mirrors {@code realmrole.HumanOnlyPermissions}; the drift test compares
     * the two.
     *
     * <p>{@code roles:manage} is absent because ADR-091 RETIRED it from the
     * catalog outright — role administration is the owner pointer now, so there
     * is no permission string left to withhold.
     */
    public static final Set<String> HUMAN_ONLY_PERMISSIONS = Set.of(
            "signing_keys:rotate",  // realm-wide credential operation
            "domains:manage",       // changes the realm's identity surface
            "platform:config",      // realm-wide policy
            "federation:manage");   // establishes cross-realm trust

    /**
     * ADR-101 D6 — does this role CONFER AUTHORITY?
     *
     * <p>Nobody but the tenant OWNER may seat a principal at such a role, on any
     * of the four paths that write {@code users.role} (invite, role change, bulk
     * import, service-account create). The server enforces it and answers
     * {@code 403 role_owner_only}.
     *
     * <p><b>Derived from the grants, never from the NAME.</b> That is the whole
     * point of D6: a realm may hold a role called {@code admin} with no
     * permissions and a role called {@code reporting} that can revoke sessions.
     *
     * @param role the role; a {@code null} role confers nothing — there are no
     *             grants to classify, and a caller that could not resolve the
     *             role has a different problem to report
     */
    public static boolean confersAuthority(RoleObject role) {
        return role != null && confersAuthority(role.permissions());
    }

    /**
     * ADR-101 D6 against the realm's SERVED ADR-074 catalog
     * ({@code roles().listPermissions()}), which gives the issuer's answer
     * EXACTLY: a grant string the catalog does not name is CONFERRING, the same
     * fail-closed classification {@code realmrole.IsMutatingPermission} makes,
     * and one that parsing the string alone cannot reproduce.
     *
     * <p>Pass {@code null} for {@code catalog} — or use the one-argument form —
     * when you do not have one; classification then falls back to the
     * {@code resource:action} split, which agrees with the issuer for every
     * catalog entry.
     */
    public static boolean confersAuthority(List<String> permissions,
                                           java.util.Collection<Permission> catalog) {
        if (catalog == null) {
            return confersAuthority(permissions);
        }
        if (permissions == null) {
            return false;
        }
        java.util.Map<String, String> known = new java.util.HashMap<>();
        for (Permission p : catalog) {
            if (p != null && p.key() != null) {
                known.put(p.key(), p.action());
            }
        }
        for (String p : permissions) {
            if (p == null) {
                return true;
            }
            String s = p.trim();
            if (s.isEmpty()) {
                continue;
            }
            String action = known.get(s);
            if (action == null || !action.equals("read")) {
                return true;
            }
        }
        return false;
    }

    /**
     * ADR-101 D6 over a bare permission list — "any grant whose ACTION is not
     * {@code read}", exactly how {@code realmrole.mutatingPermissions} derives
     * the same answer from the ADR-074 catalog.
     *
     * <p><b>Fail closed on anything unparseable.</b> A permission is
     * {@code resource:action}; an entry with no colon (a legacy free-form
     * string, ADR-074 § Storage) or a {@code null} entry is treated as
     * CONFERRING. An entry we cannot read must never be assumed harmless — the
     * issuer classifies every string outside its catalog as mutating for the
     * same reason.
     *
     * <p>One narrow difference from the server, stated rather than hidden: the
     * issuer also treats a WELL-FORMED but non-catalog key ({@code widgets:read})
     * as conferring, because it can check catalog membership and this SDK
     * deliberately embeds no copy of the catalog — a static copy would be the
     * drift-by-copy failure one level down. Pass the served catalog to
     * {@link #confersAuthority(List, java.util.Collection)} for the issuer's
     * exact answer. Such a role is unstorable anyway — write validation rejects
     * it with {@code unknown_permission} — so the case is reachable only for a
     * legacy row, and the console erring toward OFFERING there is caught by the
     * server.
     *
     * @param permissions the role's grants; {@code null} or empty confers nothing
     */
    public static boolean confersAuthority(List<String> permissions) {
        if (permissions == null) {
            return false;
        }
        for (String p : permissions) {
            if (p == null) {
                return true;
            }
            String s = p.trim();
            if (s.isEmpty()) {
                continue;
            }
            int colon = s.indexOf(':');
            if (colon < 0) {
                return true;
            }
            if (!s.substring(colon + 1).equals("read")) {
                return true;
            }
        }
        return false;
    }

    /**
     * ADR-081 — may a principal of {@code kind} hold {@code role}?
     *
     * <p>Three rules, in the order the issuer applies them:
     *
     * <ol>
     *   <li>System rows ({@link #SYSTEM_UNASSIGNABLE}) and soft-disabled roles
     *       are never assignable. (The {@code sdk/ts} sibling splits these two
     *       guards out as {@code isRoleSeatable}; Java keeps the go shape — one
     *       predicate a picker can call — see {@code ../TODO.md}.)
     *   <li>A declared {@code assignable_to} set must contain the kind.
     *       <b>EMPTY OR ABSENT MEANS ANY</b> — read-time fails OPEN. Since
     *       ADR-081 § Amendment 2 the issuer never stores it empty, so this only
     *       fires for a response from an issuer older than v0.57.0, where
     *       degrading to pre-ADR-081 behaviour beats emptying every picker.
     *       Write-time is where the rule is enforced.
     *   <li>The §2.3 human-only floor, which holds regardless of what the role
     *       declares — but applies to PARTNER-AUTHORED roles only. ADR-091
     *       exempts {@code is_system} roles: the RI-managed bot roles are the
     *       realm's machine identity by construction and hold realm-control
     *       grants on purpose.
     * </ol>
     *
     * @param role the role; {@code null} is not assignable — there is nothing to offer
     * @param kind {@link #KIND_HUMAN} or {@link #KIND_SERVICE}; {@code null} is not assignable
     */
    public static boolean isRoleAssignableTo(RoleObject role, String kind) {
        if (role == null || kind == null) {
            return false;
        }
        if (role.name() != null && SYSTEM_UNASSIGNABLE.contains(role.name())) {
            return false;
        }
        if (role.disabled()) {
            return false;
        }
        List<String> declared = role.assignableTo();
        if (declared != null && !declared.isEmpty() && !declared.contains(kind)) {
            return false;
        }
        if (!KIND_SERVICE.equals(kind)) {
            return true;
        }
        if (role.isSystem()) {
            return true;
        }
        List<String> perms = role.permissions();
        if (perms != null) {
            for (String p : perms) {
                if (p != null && HUMAN_ONLY_PERMISSIONS.contains(p.trim())) {
                    return false;
                }
            }
        }
        return true;
    }
}
