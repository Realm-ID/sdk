package dev.realmid.sdk.integrations;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/**
 * One inbound edge in a target org's access list (ADR-083 §4.5): who can act in
 * the org, as what. Mirrors Go's {@code realmid.Installation}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record Installation(
        String id,
        @JsonProperty("integration_id") @JsonAlias("integrationId") String integrationId,
        @JsonProperty("source_realm_id") @JsonAlias("sourceRealmId") String sourceRealmId,
        @JsonProperty("integration_slug") @JsonAlias("integrationSlug") String integrationSlug,
        @JsonProperty("integration_display_name") @JsonAlias("integrationDisplayName") String integrationDisplayName,
        // The ADR-101 D7 stated grant — what the brokered principal may do. It
        // REPLACED role_id/role_name, which named a role and inherited whatever
        // that role happened to grant that day.
        List<String> permissions,
        @JsonProperty("principal_user_id") @JsonAlias("principalUserId") String principalUserId,
        @JsonProperty("approved_by_user_id") @JsonAlias("approvedByUserId") String approvedByUserId,
        @JsonProperty("approved_at") @JsonAlias("approvedAt") String approvedAt,
        @JsonProperty("last_used_at") @JsonAlias("lastUsedAt") String lastUsedAt,
        @JsonProperty("mint_count") @JsonAlias("mintCount") long mintCount) {
}
