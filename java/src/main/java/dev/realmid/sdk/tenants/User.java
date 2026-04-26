package dev.realmid.sdk.tenants;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

@JsonIgnoreProperties(ignoreUnknown = true)
public record User(
        String id,
        String email,
        @JsonProperty("display_name") @JsonAlias("displayName") String displayName,
        String status,
        @JsonProperty("mfa_enabled") @JsonAlias("mfaEnabled") Boolean mfaEnabled,
        String role
) {}
