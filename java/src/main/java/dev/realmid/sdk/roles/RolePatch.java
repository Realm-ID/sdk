package dev.realmid.sdk.roles;

import java.util.List;

/**
 * PATCH body for {@code /platforms/{id}/roles/{roleId}}. Null fields are
 * omitted from the wire payload (signal "don't touch").
 */
public record RolePatch(String displayName, List<String> permissions, List<String> requiredMfaMethods) {

    /** Back-compat 2-arg constructor (pre-ADR-075, no per-role MFA). */
    public RolePatch(String displayName, List<String> permissions) {
        this(displayName, permissions, null);
    }

    public static RolePatch onlyDisplayName(String d) { return new RolePatch(d, null, null); }

    public static RolePatch onlyPermissions(List<String> p) { return new RolePatch(null, p, null); }

    /** ADR-075: set the per-role MFA method set (subset of {@code totp,otp}); {@code []} clears it. */
    public static RolePatch onlyRequiredMfaMethods(List<String> m) { return new RolePatch(null, null, m); }
}
