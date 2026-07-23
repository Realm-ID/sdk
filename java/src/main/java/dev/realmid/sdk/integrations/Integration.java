package dev.realmid.sdk.integrations;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * A source platform's published integration (ADR-082/083). Mirrors Go's
 * {@code realmid.Integration} / TS's {@code Integration}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record Integration(
        String id,
        @JsonProperty("realm_id") @JsonAlias("realmId") String realmId,
        String slug,
        @JsonProperty("display_name") @JsonAlias("displayName") String displayName,
        String description,
        @JsonProperty("homepage_url") @JsonAlias("homepageUrl") String homepageUrl,
        boolean listed,
        boolean disabled,
        @JsonProperty("created_at") @JsonAlias("createdAt") String createdAt,
        @JsonProperty("updated_at") @JsonAlias("updatedAt") String updatedAt) {
}
