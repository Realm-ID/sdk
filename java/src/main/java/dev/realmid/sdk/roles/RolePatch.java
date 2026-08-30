package dev.realmid.sdk.roles;

import java.util.List;

/**
 * PATCH body for {@code /platforms/{id}/roles/{roleId}}. Null fields are
 * omitted from the wire payload (signal "don't touch").
 *
 * <p><b>Base-realm only since ADR-101 D4</b> — see {@link RoleCreate}.
 *
 * <p>An EMPTY list clears {@code permissions}. {@code assignableTo} is the
 * exception: there is no "clear back to any" since ADR-081 &sect; Amendment 2,
 * so an empty list is a 400 {@code assignable_to_required} — name the kinds
 * instead. Narrowing {@code assignableTo} so humans may no longer hold the role
 * MIGRATES its existing human holders, in the same transaction, to the realm's
 * default invitation role (else {@code member}); the returned
 * {@link RoleObject} then carries {@code migratedHolders} +
 * {@code migratedHoldersTo}.
 *
 * <p>{@code requiredMfaMethods} (ADR-075) and {@code canInviteRoles}
 * (ADR-076 WP4) were REMOVED by ADR-101 along with the columns behind them.
 */
public record RolePatch(String displayName, List<String> permissions, List<String> assignableTo) {

    public RolePatch(String displayName, List<String> permissions) {
        this(displayName, permissions, null);
    }

    public static RolePatch onlyDisplayName(String d) { return new RolePatch(d, null, null); }

    public static RolePatch onlyPermissions(List<String> p) { return new RolePatch(null, p, null); }

    /**
     * ADR-081: set the principal kinds that may hold the role — a non-empty
     * subset of {@code ["human","service"]}. {@code []} is rejected server-side.
     */
    public static RolePatch onlyAssignableTo(List<String> kinds) {
        return new RolePatch(null, null, kinds);
    }
}
