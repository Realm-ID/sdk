package dev.realmid.sdk.roles;

import java.util.List;

/**
 * PATCH body for {@code /realms/{id}/roles/{name}}. Null fields are
 * omitted from the wire payload (signal "don't touch").
 */
public record RolePatch(String displayName, List<String> permissions) {

    public static RolePatch onlyDisplayName(String d) { return new RolePatch(d, null); }

    public static RolePatch onlyPermissions(List<String> p) { return new RolePatch(null, p); }
}
