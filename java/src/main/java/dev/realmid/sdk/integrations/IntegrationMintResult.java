package dev.realmid.sdk.integrations;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Brokered token (ADR-083 §4.3). There is NO refresh token — the token cannot
 * be renewed, so re-mint via {@link IntegrationsClient#mintToken} as expiry
 * nears. {@code expiresIn} is a fixed 600 seconds.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record IntegrationMintResult(
        @JsonProperty("access_token") @JsonAlias("accessToken") String accessToken,
        @JsonProperty("expires_in") @JsonAlias("expiresIn") long expiresIn,
        @JsonProperty("tenant_id") @JsonAlias("tenantId") String tenantId,
        String role) {
}
