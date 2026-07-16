package dev.realmid.sdk.tenants;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Response shape returned by {@link TenantsClient#updateUserRole}
 * (PATCH /tenants/{id}/users/{uid}/role). {@code updatedAt} is unix
 * seconds (the issuer serializes it as a JSON number).
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record UpdateUserRoleResult(
        String id,
        String role,
        @JsonProperty("tenant_id") @JsonAlias("tenantId") String tenantId,
        @JsonProperty("updated_at") @JsonAlias("updatedAt") Long updatedAt
) {}
