package dev.realmid.sdk.tenants;

/**
 * One row for {@link UsersClient#importUsers} (ADR-073 Release B). At least
 * one of {@code email}/{@code phone} is required.
 *
 * @param userId      optional caller-supplied UUID that becomes {@code users.id}
 *        (bring-your-own; reconciles in THIS tenant, rejects the file if it
 *        exists in another). Absent → a UUIDv7 is minted and returned.
 * @param email       email identifier.
 * @param phone       E.164 phone (leading {@code +}).
 * @param role        realm-catalog role ({@code owner}/{@code platform_api} rejected).
 * @param displayName optional display name.
 * @param provider    with {@code providerUid}, writes an exact first-SSO binding
 *        ({@code google|microsoft|apple|facebook|firebase}).
 * @param providerUid provider subject identifier.
 */
public record ImportUserRow(
        String userId,
        String email,
        String phone,
        String role,
        String displayName,
        String provider,
        String providerUid) {

    /** Minimal email+role row. */
    public static ImportUserRow of(String email, String role) {
        return new ImportUserRow(null, email, null, role, null, null, null);
    }
}
