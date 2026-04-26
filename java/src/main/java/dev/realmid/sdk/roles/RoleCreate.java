package dev.realmid.sdk.roles;

import java.util.List;

/** POST body for {@code /realms/{id}/roles}. */
public record RoleCreate(String name, String displayName, List<String> permissions) {

    public RoleCreate(String name) { this(name, null, null); }
}
