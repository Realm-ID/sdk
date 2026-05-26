package dev.realmid.sdk.tenants;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/** SPEC §6.8 — a returning-login contact-drift queue row. */
@JsonIgnoreProperties(ignoreUnknown = true)
public record DriftReview(
        String id,
        @JsonProperty("contact_id") String contactId,
        @JsonProperty("user_id") String userId,
        @JsonProperty("asserted_value") String assertedValue,
        @JsonProperty("asserted_method") String assertedMethod,
        @JsonProperty("asserted_provider_uid") String assertedProviderUid,
        @JsonProperty("seen_count") int seenCount,
        @JsonProperty("first_seen_at") long firstSeenAt,
        @JsonProperty("last_seen_at") long lastSeenAt,
        String status
) {}
