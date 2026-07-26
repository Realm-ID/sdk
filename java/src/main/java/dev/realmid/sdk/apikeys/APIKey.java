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
 *   <li>On list: {@code id}, {@code prefix}, {@code label}, {@code role},
 *       {@code createdAt}, {@code lastUsedAt}, {@code expiresAt},
 *       {@code revokedAt} are set; {@code value} is never returned.</li>
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
        /**
         * The label supplied at create — echoed there and present on every list
         * row (issuer v0.61.0, ADR-085 §7). It is the only handle on a key: the
         * plaintext is never echoed and {@code prefix} is derived from the
         * stored hash, so an {@code rk_live_…} found in a log cannot be traced
         * to its row by value.
         */
        String label,
        /** The raw secret key, returned ONLY on create (one-time reveal). */
        String value,
        @JsonProperty("created_at") @JsonAlias("createdAt") Long createdAt,
        @JsonProperty("last_used_at") @JsonAlias("lastUsedAt") Long lastUsedAt,
        @JsonProperty("revoked_at") @JsonAlias("revokedAt") Long revokedAt,
        /**
         * Scheduled cutoff in unix seconds, {@code null} for a non-expiring key
         * (ADR-085 §3). Null is a VALUE, not an absence — "never expires" is a
         * fact a caller must be able to read. An expired key behaves exactly
         * like a revoked one at login and returns the same error envelope.
         */
        @JsonProperty("expires_at") @JsonAlias("expiresAt") Long expiresAt
) {
    /** True iff the key has been soft-deleted ({@code revokedAt} set). */
    public boolean revoked() {
        return revokedAt != null;
    }

    /**
     * True iff the key is past its scheduled cutoff at {@code nowEpochSeconds}.
     * A non-expiring key ({@code expiresAt} null) is never expired.
     */
    public boolean expired(long nowEpochSeconds) {
        return expiresAt != null && nowEpochSeconds >= expiresAt;
    }
}
