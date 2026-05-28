package dev.realmid.sdk.apikeys;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * One entry from {@code realm.apiKeys.*} (SPEC §6.5). The record is a union of
 * the create-response and list-row wire shapes (the issuer's authoritative
 * {@code APIKey} / {@code APIKeyListItem} — code wins):
 *
 * <ul>
 *   <li>On create: {@code id}, {@code value} (the one-time secret), and the
 *       echoed {@code role}/{@code label} are set.</li>
 *   <li>On list: {@code id}, {@code prefix}, {@code role}, {@code createdAt},
 *       {@code lastUsedAt}, {@code revokedAt} are set; {@code value} is never
 *       returned.</li>
 * </ul>
 *
 * Timestamps are unix seconds. {@code lastUsedAt} and {@code revokedAt} are
 * nullable; a non-null {@code revokedAt} means the key is revoked. {@code role}
 * is the key's bound role — a singular string, not a {@code scopes} array.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record APIKey(
        String id,
        /** Non-secret key prefix (list rows), stable across logs. */
        String prefix,
        /** The key's bound role (singular; not a scopes array). */
        String role,
        /** Optional human-readable name supplied on create. */
        String label,
        /** The raw secret key, returned ONLY on create (one-time reveal). */
        String value,
        @JsonProperty("created_at") @JsonAlias("createdAt") Long createdAt,
        @JsonProperty("last_used_at") @JsonAlias("lastUsedAt") Long lastUsedAt,
        @JsonProperty("revoked_at") @JsonAlias("revokedAt") Long revokedAt
) {
    /** True iff the key has been soft-deleted ({@code revokedAt} set). */
    public boolean revoked() {
        return revokedAt != null;
    }
}
