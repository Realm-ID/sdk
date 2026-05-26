package dev.realmid.sdk.tenants;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/** SPEC §6.8 — result of {@link DriftReviewsClient#reject}. */
@JsonIgnoreProperties(ignoreUnknown = true)
public record DriftRejectResult(
        String id,
        String status,
        @JsonProperty("new_user_id") String newUserId,
        @JsonProperty("original_value") String originalValue
) {}
