package dev.realmid.sdk.idp;

import java.util.List;
import java.util.Map;

/**
 * PATCH body for {@code /identity-providers/{id}}. All fields are optional;
 * null fields are omitted from the wire payload (signal "don't touch"). At
 * least one field must be set or the server returns {@code empty_patch}.
 *
 * <p>{@code enabled} is a {@link Boolean} (nullable) so it can be omitted.
 *
 * <p>{@code config}, when non-null, REPLACES the stored provider config map
 * wholesale (not merged) — e.g. the Firebase web config. Publishable values
 * only; never secrets.
 */
public record IdpConfigPatch(Boolean enabled, String clientId,
                             List<String> allowedOrigins, String comments,
                             Map<String, String> config) {

    /** Backward-compatible constructor without provider config. */
    public IdpConfigPatch(Boolean enabled, String clientId,
                          List<String> allowedOrigins, String comments) {
        this(enabled, clientId, allowedOrigins, comments, null);
    }

    public static IdpConfigPatch onlyEnabled(boolean enabled) {
        return new IdpConfigPatch(enabled, null, null, null, null);
    }

    public static IdpConfigPatch onlyAllowedOrigins(List<String> origins) {
        return new IdpConfigPatch(null, null, origins, null, null);
    }

    /** Replace the provider's PUBLIC config map (e.g. the Firebase web config). */
    public static IdpConfigPatch onlyConfig(Map<String, String> config) {
        return new IdpConfigPatch(null, null, null, null, config);
    }
}
