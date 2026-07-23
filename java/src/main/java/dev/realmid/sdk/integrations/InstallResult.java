package dev.realmid.sdk.integrations;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/** Install acknowledgment. */
@JsonIgnoreProperties(ignoreUnknown = true)
public record InstallResult(
        String id,
        @JsonProperty("integration_id") @JsonAlias("integrationId") String integrationId,
        @JsonProperty("role_id") @JsonAlias("roleId") String roleId,
        @JsonProperty("role_name") @JsonAlias("roleName") String roleName,
        @JsonProperty("principal_user_id") @JsonAlias("principalUserId") String principalUserId,
        String status) {
}
