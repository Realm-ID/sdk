package dev.realmid.sdk.userapikeys;

import java.util.List;

/**
 * Mint payload for an end-user API key (SPEC §6.6).
 *
 * <p>{@code label} is required — it is the only human-readable handle on a key
 * that never shows its plaintext again. Every other field may be null to accept
 * the realm's configured default.
 *
 * @param label          required human label
 * @param orgScope       {@link OrgScope#SELECTED} or {@link OrgScope#ALL}; null =
 *                       the realm's {@code org_scope_default}
 * @param orgIds         the frozen allowlist for {@code selected}; null = just the
 *                       user's current org. Every entry must be a live membership
 *                       of the target user, else {@code 400 org_not_a_membership}
 * @param permissionsCap the cap. For the {@code realmid} audience these are
 *                       validated against RealmID's ADR-074 catalog at mint
 *                       ({@code 400 unknown_permission}); for a partner audience
 *                       they are opaque to RealmID and shape-validated only
 * @param ttlSeconds     null = the realm default; above the realm ceiling returns
 *                       {@code 400 ttl_exceeds_max}; {@code 0} requests a
 *                       non-expiring key, which needs
 *                       {@code user_api_keys.allow_non_expiring}
 */
public record UserAPIKeyCreate(
        String label,
        String orgScope,
        List<String> orgIds,
        List<String> permissionsCap,
        Integer ttlSeconds
) {
    /** Convenience for the common case: a label and nothing else. */
    public static UserAPIKeyCreate of(String label) {
        return new UserAPIKeyCreate(label, null, null, null, null);
    }
}
