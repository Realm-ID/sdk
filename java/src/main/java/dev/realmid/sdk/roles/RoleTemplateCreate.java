package dev.realmid.sdk.roles;

import java.util.List;

/**
 * Body for {@link RoleTemplatesClient#create}.
 *
 * <p>{@code assignableTo} is REQUIRED and non-empty (ADR-081 § Amendment 2) —
 * an empty set is an unfinished row, not "any kind".
 */
public record RoleTemplateCreate(
        String level,
        String name,
        String displayName,
        List<String> permissions,
        List<String> assignableTo,
        Boolean system,
        Boolean optional) {

    /** The common case: a floor template that fans out. */
    public static RoleTemplateCreate of(String level, String name, List<String> assignableTo) {
        return new RoleTemplateCreate(level, name, null, null, assignableTo, null, null);
    }
}
