package dev.realmid.sdk.me;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Outcome of {@link MeClient#rejectInvitation} ({@code "rejected"}) or
 * {@link MeClient#leave} ({@code "left"}).
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record MembershipResult(
        @JsonProperty("tenant_id") @JsonAlias("tenantId") String tenantId,
        String status) {}
