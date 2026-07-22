package dev.realmid.sdk.roles;

import java.util.List;

/**
 * PATCH body for {@code /platforms/{id}/roles/{roleId}}. Null fields are
 * omitted from the wire payload (signal "don't touch").
 *
 * <p>An EMPTY list clears {@code permissions}, {@code requiredMfaMethods} and
 * {@code canInviteRoles}. {@code assignableTo} is the exception: there is no
 * "clear back to any" since ADR-081 &sect; Amendment 2, so an empty list is a
 * 400 {@code assignable_to_required} — name the kinds instead. Narrowing
 * {@code assignableTo} so humans may no longer hold the role MIGRATES its
 * existing human holders, in the same transaction, to the realm's default
 * invitation role (else {@code member}); the returned {@link RoleObject} then
 * carries {@code migratedHolders} + {@code migratedHoldersTo}.
 */
public record RolePatch(String displayName, List<String> permissions, List<String> requiredMfaMethods,
                        List<String> canInviteRoles, List<String> assignableTo) {

    /** Back-compat 2-arg constructor (pre-ADR-075, no per-role MFA). */
    public RolePatch(String displayName, List<String> permissions) {
        this(displayName, permissions, null, null, null);
    }

    /** Back-compat 3-arg constructor (pre-ADR-076/081: no invite scope, no principal typing). */
    public RolePatch(String displayName, List<String> permissions, List<String> requiredMfaMethods) {
        this(displayName, permissions, requiredMfaMethods, null, null);
    }

    public static RolePatch onlyDisplayName(String d) { return new RolePatch(d, null, null, null, null); }

    public static RolePatch onlyPermissions(List<String> p) { return new RolePatch(null, p, null, null, null); }

    /** ADR-075: set the per-role MFA method set (subset of {@code totp,otp}); {@code []} clears it. */
    public static RolePatch onlyRequiredMfaMethods(List<String> m) {
        return new RolePatch(null, null, m, null, null);
    }

    /** ADR-076 WP4: set the invitation scope; {@code []} clears it. */
    public static RolePatch onlyCanInviteRoles(List<String> r) {
        return new RolePatch(null, null, null, r, null);
    }

    /**
     * ADR-081: set the principal kinds that may hold the role — a non-empty
     * subset of {@code ["human","service"]}. {@code []} is rejected server-side.
     */
    public static RolePatch onlyAssignableTo(List<String> kinds) {
        return new RolePatch(null, null, null, null, kinds);
    }
}
