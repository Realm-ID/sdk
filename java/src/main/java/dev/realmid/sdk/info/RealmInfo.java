package dev.realmid.sdk.info;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

@JsonIgnoreProperties(ignoreUnknown = true)
public record RealmInfo(
        String id,
        String audience,
        @JsonProperty("display_name") @JsonAlias("displayName") String displayName
) {}
