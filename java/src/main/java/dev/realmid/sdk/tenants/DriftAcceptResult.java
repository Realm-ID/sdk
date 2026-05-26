package dev.realmid.sdk.tenants;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/** SPEC §6.8 — result of {@link DriftReviewsClient#accept}. */
@JsonIgnoreProperties(ignoreUnknown = true)
public record DriftAcceptResult(
        String id,
        String status,
        @JsonProperty("accepted_value") String acceptedValue,
        @JsonProperty("new_contact_id") String newContactId
) {}
