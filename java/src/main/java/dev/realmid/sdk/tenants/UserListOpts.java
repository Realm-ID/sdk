package dev.realmid.sdk.tenants;

/**
 * Optional filters for {@link UsersClient#list} (SPEC §6.3, S-07). All fields
 * optional; empty/null fields are omitted from the query. Invalid role/status
 * values are rejected server-side (400 invalid_role / invalid_status).
 *
 * @param role   exact match: owner|admin|member|viewer.
 * @param status exact match: active|suspended|invited|deactivated.
 * @param q      case-insensitive substring match on email.
 */
public record UserListOpts(String role, String status, String q) {
    public static UserListOpts empty() { return new UserListOpts(null, null, null); }
    public static UserListOpts withRole(String role) { return new UserListOpts(role, null, null); }
    public static UserListOpts withStatus(String status) { return new UserListOpts(null, status, null); }
    public static UserListOpts withQuery(String q) { return new UserListOpts(null, null, q); }
}
