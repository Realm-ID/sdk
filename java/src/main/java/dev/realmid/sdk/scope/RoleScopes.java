package dev.realmid.sdk.scope;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

/**
 * ADR-097 / ADR-100 D9 — the ROLE&nbsp;-&gt;&nbsp;SCOPE map.
 *
 * <p>{@link ScopePolicy} is the route&nbsp;-&gt;&nbsp;scope half: given a token,
 * may this request proceed. This class is the other half: given the roles a
 * user holds in YOUR product, what scopes should their token carry.
 *
 * <p>Both maps live in the PARTNER'S repo. RealmID stores neither, and that is
 * the whole point of ADR-101 — adding a product role is a change in your
 * codebase, not a write into someone else's database with an owner-bound
 * credential.
 *
 * <p><b>"Role" here means YOUR role, not {@code realm_roles}.</b> The two are
 * unrelated and easy to conflate. {@code realm_roles} is RealmID's own
 * administrative vocabulary — what a user may do TO REALMID. A scope governs
 * what a user may do inside YOUR product. RealmID never sees your roles and
 * never sees your scopes.
 *
 * <h2>Where the output goes</h2>
 *
 * <pre>{@code
 * List<String> scopes = RoleScopes.scopesForRoles(MY_ROLES, user.roles());
 * realm.auth().login(LoginRequest.builder()
 *     .scope(scopes)            // what to request
 *     .rolePermissions(scopes)  // what the role actually confers
 *     .build());
 * }</pre>
 *
 * <p>Passing the same list to both is the common case and is correct:
 * {@code scope} is the request and {@code rolePermissions} is the bound. They
 * differ only when you want to request LESS than the role confers. RealmID
 * intersects {@code rolePermissions} with any stored user-API-key
 * {@code permissions_cap}, so the minted token carries ONE effective set.
 */
public final class RoleScopes {

    private RoleScopes() {}

    /**
     * The union of scopes conferred by {@code roles}, sorted and de-duplicated.
     *
     * <p>Sorted because the result is compared, logged and sent on the wire, and
     * an order that depends on map iteration makes two identical grants look
     * different. De-duplicated because two roles commonly confer the same scope.
     *
     * <p><b>Fail-closed, and deliberately silent.</b> A role the map does not
     * know contributes NOTHING. A user holding an unmapped role gets fewer
     * scopes and is refused at the gate; throwing instead would lock people out
     * of your product over a config gap. Call {@link #validate} at startup to
     * catch the gap before it costs anyone a scope.
     *
     * @return an unmodifiable list, empty when nothing is conferred
     */
    public static List<String> scopesForRoles(Map<String, List<String>> map, List<String> roles) {
        if (map == null || map.isEmpty() || roles == null || roles.isEmpty()) {
            return List.of();
        }
        TreeSet<String> seen = new TreeSet<>();
        for (String role : roles) {
            List<String> scopes = map.get(role);
            if (scopes == null) {
                continue;
            }
            for (String s : scopes) {
                if (s != null && !s.isEmpty()) {
                    seen.add(s);
                }
            }
        }
        return List.copyOf(seen);
    }

    /** The role names the map knows, sorted. */
    public static List<String> roleNames(Map<String, List<String>> map) {
        if (map == null || map.isEmpty()) {
            return List.of();
        }
        List<String> out = new ArrayList<>(map.keySet());
        Collections.sort(out);
        return List.copyOf(out);
    }

    /**
     * Reports configuration errors. Call it once at startup — a bad entry here
     * costs a user their authority at request time, far from the typo.
     *
     * <p>Three refusals: an empty role name (which no token can match); a role
     * mapped to no scopes (almost always an unfinished entry — express "this
     * role may do nothing" by omitting the role, with a comment); and a scope
     * that is not a legal RFC 6749 §3.3 token, which the issuer refuses at mint.
     * Catching the last one here turns a login-time failure into a start-up
     * failure.
     *
     * @return one human-readable message per problem, empty when the map is good
     */
    public static List<String> validate(Map<String, List<String>> map) {
        List<String> errs = new ArrayList<>();
        for (String role : roleNames(map)) {
            if (role == null || role.isEmpty()) {
                errs.add("role scopes: role name is empty");
                continue;
            }
            List<String> scopes = map.get(role);
            if (scopes == null || scopes.isEmpty()) {
                errs.add("role scopes: role \"" + role + "\" maps to no scopes; omit the role instead");
                continue;
            }
            for (String s : scopes) {
                if (!Scopes.isRfc6749ScopeToken(s)) {
                    errs.add("role scopes: role \"" + role + "\" maps to \"" + s
                            + "\", which is not a legal RFC 6749 scope token");
                }
            }
        }
        return List.copyOf(errs);
    }
}
