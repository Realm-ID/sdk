package dev.realmid.sdk.tenants;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Result of {@link UsersClient#handBack} (ADR-080 Part 3): the reactivated
 * account and the email identity moved onto it. {@code status} is
 * {@code "handed_back"}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record HandBackResult(
        String status,
        @JsonProperty("user_id") String userId,
        String email
) {}
