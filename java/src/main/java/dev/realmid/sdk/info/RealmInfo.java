package dev.realmid.sdk.info;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * @param originEnforcement the realm's browser-Origin policy ({@code origin_enforcement}); null
 *                          when the realm did not state one. The middleware's AUTO mode enforces
 *                          iff this is {@code "required"}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record RealmInfo(
        String id,
        String audience,
        @JsonProperty("display_name") @JsonAlias("displayName") String displayName,
        @JsonProperty("origin_enforcement") String originEnforcement
) {
    public RealmInfo(String id, String audience, String displayName) {
        this(id, audience, displayName, null);
    }
}
