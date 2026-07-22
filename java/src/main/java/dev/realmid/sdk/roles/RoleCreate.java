package dev.realmid.sdk.roles;

import java.util.List;

/**
 * POST body for {@code /platforms/{id}/roles}.
 *
 * <p>{@code canInviteRoles} is the ADR-076 WP4 invitation scope (each entry a
 * known non-owner role name in the realm). {@code assignableTo} is the ADR-081
 * principal-kind constraint — any non-empty subset of
 * {@code ["human","service"]}. Leaving {@code assignableTo} null omits the key
 * and the server defaults to BOTH kinds; that is not an error, the field is
 * younger than its clients. An explicitly EMPTY list is a 400
 * {@code assignable_to_required}: ADR-081 &sect; Amendment 2 removed
 * "unconstrained" as a storable state, so name the kinds instead.
 */
public record RoleCreate(String name, String displayName, List<String> permissions,
                         List<String> requiredMfaMethods, List<String> canInviteRoles,
                         List<String> assignableTo) {

    public RoleCreate(String name) { this(name, null, null, null, null, null); }

    /** Back-compat 3-arg constructor (pre-ADR-075, no per-role MFA). */
    public RoleCreate(String name, String displayName, List<String> permissions) {
        this(name, displayName, permissions, null, null, null);
    }

    /** Back-compat 4-arg constructor (pre-ADR-076/081: no invite scope, no principal typing). */
    public RoleCreate(String name, String displayName, List<String> permissions,
                      List<String> requiredMfaMethods) {
        this(name, displayName, permissions, requiredMfaMethods, null, null);
    }
}
