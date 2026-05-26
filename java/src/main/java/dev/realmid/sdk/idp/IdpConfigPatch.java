package dev.realmid.sdk.idp;

import java.util.List;

/**
 * PATCH body for {@code /identity-providers/{id}}. All fields are optional;
 * null fields are omitted from the wire payload (signal "don't touch"). At
 * least one field must be set or the server returns {@code empty_patch}.
 *
 * <p>{@code enabled} is a {@link Boolean} (nullable) so it can be omitted.
 */
public record IdpConfigPatch(Boolean enabled, String clientId,
                             List<String> allowedOrigins, String comments) {

    public static IdpConfigPatch onlyEnabled(boolean enabled) {
        return new IdpConfigPatch(enabled, null, null, null);
    }

    public static IdpConfigPatch onlyAllowedOrigins(List<String> origins) {
        return new IdpConfigPatch(null, null, origins, null);
    }
}
