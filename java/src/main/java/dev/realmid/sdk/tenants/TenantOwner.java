package dev.realmid.sdk.tenants;

/**
 * Seats a tenant's owner inline at create (ADR-073 Amendment C.2). At least
 * one of {@code email}/{@code phone} is required.
 *
 * <p>There is deliberately no role: the owner gets the dormant {@code member}
 * role (ADR-076 — ownership is the {@code owner_user_id} pointer, not a role
 * name); the owner's real app-role, if any, arrives via the roster import that
 * reuses {@code userId}.
 *
 * @param userId      optional bring-your-own owner id; absent → minted.
 * @param email       email identifier.
 * @param phone       E.164 phone (leading {@code +}).
 * @param displayName optional display name.
 * @param provider    with {@code providerUid}, writes the owner's exact
 *        first-SSO binding ({@code google|microsoft|apple|facebook|firebase}).
 * @param providerUid provider subject identifier.
 */
public record TenantOwner(
        String userId,
        String email,
        String phone,
        String displayName,
        String provider,
        String providerUid) {

    /** Owner seated by email only. */
    public static TenantOwner ofEmail(String email) {
        return new TenantOwner(null, email, null, null, null, null);
    }

    /** Owner seated by phone only (E.164). */
    public static TenantOwner ofPhone(String phone) {
        return new TenantOwner(null, null, phone, null, null, null);
    }

    /** Owner pinned to an existing user id. */
    public static TenantOwner ofUserId(String userId) {
        return new TenantOwner(userId, null, null, null, null, null);
    }
}
