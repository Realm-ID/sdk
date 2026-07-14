package dev.realmid.sdk.serviceaccounts;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/** Response for {@code POST /tenants/{id}/service-accounts/{said}/revoke}. */
@JsonIgnoreProperties(ignoreUnknown = true)
public record ServiceAccountRevokeResult(
        String status,
        @JsonProperty("revoked_sessions") @JsonAlias("revokedSessions") int revokedSessions) {
}
