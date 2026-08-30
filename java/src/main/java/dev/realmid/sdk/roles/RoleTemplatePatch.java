package dev.realmid.sdk.roles;

import java.util.List;

/**
 * Body for {@link RoleTemplatesClient#update}. Every field nullable: a NULL is
 * OMITTED from the request and preserves the stored value.
 *
 * <p>{@code level} and {@code name} are absent by design — they are the
 * identity, and a rename is a delete plus a create.
 */
public record RoleTemplatePatch(
        String displayName,
        List<String> permissions,
        List<String> assignableTo,
        Boolean system,
        Boolean optional) {

    public static RoleTemplatePatch displayName(String v) {
        return new RoleTemplatePatch(v, null, null, null, null);
    }

    public static RoleTemplatePatch permissions(List<String> v) {
        return new RoleTemplatePatch(null, v, null, null, null);
    }
}
