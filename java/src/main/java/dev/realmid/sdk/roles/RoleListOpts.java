package dev.realmid.sdk.roles;

/** Optional pagination inputs for {@link RolesClient#list}. */
public record RoleListOpts(String cursor, Integer limit) {

    public static RoleListOpts empty() { return new RoleListOpts(null, null); }

    public static RoleListOpts withCursor(String c) { return new RoleListOpts(c, null); }
}
