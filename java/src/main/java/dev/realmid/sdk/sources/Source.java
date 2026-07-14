package dev.realmid.sdk.sources;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/**
 * One app/source registration (issuer sourceDTO, ADR-072).
 *
 * <p>A source is a platform-level client app (web/android/ios/desktop human
 * app, or the {@code bot} service-account app); {@code allowedMethods} is
 * mapping-2 (the login methods that app surfaces).
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record Source(
        String id,
        @JsonProperty("platform_id") @JsonAlias("platformId") String platformId,
        String type,
        String label,
        @JsonProperty("allowed_methods") @JsonAlias("allowedMethods") List<String> allowedMethods,
        boolean enabled,
        @JsonProperty("created_at") @JsonAlias("createdAt") long createdAt) {
}
