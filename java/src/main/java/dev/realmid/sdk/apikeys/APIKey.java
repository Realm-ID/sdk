package dev.realmid.sdk.apikeys;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

@JsonIgnoreProperties(ignoreUnknown = true)
public record APIKey(
        String id,
        @JsonProperty("display_name") @JsonAlias("displayName") String displayName,
        String prefix,
        String secret,
        List<String> scopes,
        @JsonProperty("created_at") @JsonAlias("createdAt") String createdAt,
        @JsonProperty("revoked_at") @JsonAlias("revokedAt") String revokedAt
) {}
