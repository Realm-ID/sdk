package dev.realmid.sdk.auth;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/** SPEC §4.2 response. */
@JsonIgnoreProperties(ignoreUnknown = true)
public record TokenResponse(
        @JsonProperty("access_token") @JsonAlias("accessToken") String accessToken,
        @JsonProperty("refresh_token") @JsonAlias("refreshToken") String refreshToken,
        @JsonProperty("expires_in") @JsonAlias("expiresIn") long expiresIn,
        @JsonProperty("tenant_id") @JsonAlias("tenantId") String tenantId,
        String role
) {}
