package dev.realmid.sdk.roles;

import java.util.List;

/** POST body for {@code /platforms/{id}/roles}. */
public record RoleCreate(String name, String displayName, List<String> permissions,
                         List<String> requiredMfaMethods) {

    public RoleCreate(String name) { this(name, null, null, null); }

    /** Back-compat 3-arg constructor (pre-ADR-075, no per-role MFA). */
    public RoleCreate(String name, String displayName, List<String> permissions) {
        this(name, displayName, permissions, null);
    }
}
