package dev.realmid.sdk.userapikeys;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/**
 * One entry from {@code realm.userApiKeys.*} (SPEC §6.6, ADR-084).
 *
 * <p>DISTINCT from {@link dev.realmid.sdk.apikeys.APIKey} in every respect:
 * separate table, separate route segment ({@code user-api-keys}), separate
 * plaintext prefix ({@code uk_live_} vs {@code rk_live_}), and a separate
 * permission pair ({@code user_api_keys:read|manage}). An org admin managing
 * members' keys must not thereby gain platform-key power, and a leaked string
 * should be classifiable at a glance.
 *
 * <p>A union of the create-response and list-row wire shapes (issuer wins):
 *
 * <ul>
 *   <li>On create: {@code id}, {@code value} (the one-time secret), {@code label},
 *       {@code orgScope}, {@code orgIds}, {@code permissionsCap},
 *       {@code expiresAt}.</li>
 *   <li>On list: the above minus {@code value}, plus {@code prefix},
 *       {@code mintedMfaAt}, {@code createdAt}, {@code lastUsedAt},
 *       {@code revokedAt}.</li>
 * </ul>
 *
 * <p>Timestamps are unix seconds and nullable except {@code createdAt}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record UserAPIKey(
        String id,
        /**
         * The raw secret, returned ONLY on create (one-time reveal).
         * Prefix {@code uk_live_}.
         */
        String value,
        /**
         * Non-secret hash prefix (list rows). With {@code label} it is the ONLY
         * handle on a key — the plaintext is never returned again, so a found
         * {@code uk_live_…} cannot otherwise be correlated to its row.
         */
        String prefix,
        String label,
        /** {@code "selected"} or {@code "all"} — see {@link OrgScope}. */
        @JsonProperty("org_scope") @JsonAlias("orgScope") String orgScope,
        /**
         * The scope AS STORED. An org named here may no longer be reachable:
         * revocation on membership loss is an async sweep and live membership is
         * re-intersected at every exchange, so a key can LIST an org it can no
         * longer MINT into. Showing the stored value is the honest answer.
         */
        @JsonProperty("org_ids") @JsonAlias("orgIds") List<String> orgIds,
        /**
         * True when the key carries the holder's FULL authority — all current
         * and future permissions. Mutually exclusive with a non-empty
         * {@code permissionsCap}: exactly one of the two describes the key
         * (ADR-100 D2).
         */
        Boolean uncapped,
        /**
         * A CAP, NEVER A GRANT. Effective authority is {@code permissionsCap ∩}
         * the principal's LIVE permissions, re-resolved per request, so it can
         * only ever UNDER-grant. Use {@link CapCheck#capAllows} — do NOT test
         * membership of this list on its own. Null or empty when
         * {@code uncapped}; otherwise non-empty — the server cannot store an
         * empty cap (ADR-100 D1).
         */
        @JsonProperty("permissions_cap") @JsonAlias("permissionsCap") List<String> permissionsCap,
        /**
         * When MFA was proven at mint; null = not proven. Load-bearing, not
         * informational: key exchange is exempt from the realm MFA floor if and
         * only if this is set.
         */
        @JsonProperty("minted_mfa_at") @JsonAlias("mintedMfaAt") Long mintedMfaAt,
        @JsonProperty("created_at") @JsonAlias("createdAt") Long createdAt,
        @JsonProperty("last_used_at") @JsonAlias("lastUsedAt") Long lastUsedAt,
        /** Null = non-expiring. */
        @JsonProperty("expires_at") @JsonAlias("expiresAt") Long expiresAt,
        @JsonProperty("revoked_at") @JsonAlias("revokedAt") Long revokedAt
) {
    /** True iff the key has been soft-revoked. */
    public boolean revoked() {
        return revokedAt != null;
    }
}
