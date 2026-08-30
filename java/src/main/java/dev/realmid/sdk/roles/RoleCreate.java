package dev.realmid.sdk.roles;

import java.util.List;

/**
 * POST body for {@code /platforms/{id}/roles}.
 *
 * <p><b>Base-realm only since ADR-101 D4.</b> RealmID defines the role set; a
 * partner cannot author a role, and this endpoint answers
 * {@code 403 role_authoring_retired} for every realm but RealmID's own. Product
 * roles belong in your system and reach RealmID as ADR-097 scopes — see
 * {@code dev.realmid.sdk.scope.RoleScopes}.
 *
 * <p>{@code assignableTo} is the ADR-081 principal-kind constraint — any
 * non-empty subset of {@code ["human","service"]}. Leaving it null omits the
 * key and the server defaults to BOTH kinds; that is not an error, the field is
 * younger than its clients. An explicitly EMPTY list is a 400
 * {@code assignable_to_required}: ADR-081 &sect; Amendment 2 removed
 * "unconstrained" as a storable state, so name the kinds instead.
 *
 * <p>{@code requiredMfaMethods} (ADR-075) and {@code canInviteRoles}
 * (ADR-076 WP4) were REMOVED by ADR-101 along with the columns behind them.
 */
public record RoleCreate(String name, String displayName, List<String> permissions,
                         List<String> assignableTo) {

    public RoleCreate(String name) { this(name, null, null, null); }

    public RoleCreate(String name, String displayName, List<String> permissions) {
        this(name, displayName, permissions, null);
    }
}
