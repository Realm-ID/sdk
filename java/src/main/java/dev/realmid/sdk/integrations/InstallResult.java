package dev.realmid.sdk.integrations;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/** Install acknowledgment. */
@JsonIgnoreProperties(ignoreUnknown = true)
public record InstallResult(
        String id,
        @JsonProperty("integration_id") @JsonAlias("integrationId") String integrationId,
        List<String> permissions,
        @JsonProperty("principal_user_id") @JsonAlias("principalUserId") String principalUserId,
        String status) {
}
