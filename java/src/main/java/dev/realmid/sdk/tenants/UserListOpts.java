package dev.realmid.sdk.tenants;

/**
 * Optional filters for {@link UsersClient#list} (SPEC §6.3, S-07). All fields
 * optional; empty/null fields are omitted from the query. Invalid role/status
 * values are rejected server-side (400 invalid_role / invalid_status).
 *
 * @param role        exact match: owner|admin|member|viewer.
 * @param status      exact match: active|suspended|invited|deactivated.
 * @param q           case-insensitive substring match on email.
 * @param joinedVia   exact match on how the membership was created
 *                    (invitation|sso_domain|open_signup|import|admin|owner|service|unknown);
 *                    invalid values are a 400.
 * @param emailDomain members whose email ends in {@code @<domain>}; says nothing
 *                    about how they joined (use {@code joinedVia}).
 */
public record UserListOpts(String role, String status, String q, String joinedVia, String emailDomain) {
    /** Pre-0.51 shape, kept so existing callers still compile. */
    public UserListOpts(String role, String status, String q) { this(role, status, q, null, null); }

    public static UserListOpts empty() { return new UserListOpts(null, null, null); }
    public static UserListOpts withRole(String role) { return new UserListOpts(role, null, null); }
    public static UserListOpts withStatus(String status) { return new UserListOpts(null, status, null); }
    public static UserListOpts withQuery(String q) { return new UserListOpts(null, null, q); }

    public UserListOpts withJoinedVia(String v) { return new UserListOpts(role, status, q, v, emailDomain); }
    public UserListOpts withJoinedVia(JoinedVia v) { return withJoinedVia(v == null ? null : v.wire()); }
    public UserListOpts withEmailDomain(String d) { return new UserListOpts(role, status, q, joinedVia, d); }
}
