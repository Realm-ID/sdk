package dev.realmid.sdk.tenants;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

@JsonIgnoreProperties(ignoreUnknown = true)
public record Invitation(
        String id,
        @JsonProperty("tenant_id") @JsonAlias("tenantId") String tenantId,
        String email,
        String role,
        String status
) {}
