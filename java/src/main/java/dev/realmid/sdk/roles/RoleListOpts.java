package dev.realmid.sdk.roles;

/**
 * Optional inputs for {@link RolesClient#list}.
 *
 * <p>{@code includeSystem} asks the server to also return system roles it
 * hides by default (currently {@code platform_api}); {@code owner}/{@code
 * member} are always returned. Maps to {@code ?include_system=true}.
 */
public record RoleListOpts(String cursor, Integer limit, boolean includeSystem) {

    public static RoleListOpts empty() { return new RoleListOpts(null, null, false); }

    public static RoleListOpts withCursor(String c) { return new RoleListOpts(c, null, false); }

    /** Include the server-hidden system roles (e.g. {@code platform_api}). */
    public static RoleListOpts includingSystem() { return new RoleListOpts(null, null, true); }
}
