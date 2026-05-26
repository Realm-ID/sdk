package dev.realmid.sdk.tenants;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/** SPEC §6.9 — first-login step-up gate row. */
@JsonIgnoreProperties(ignoreUnknown = true)
public record ContactVerification(
        String id,
        @JsonProperty("contact_id") String contactId,
        @JsonProperty("user_id") String userId,
        String method,
        @JsonProperty("provider_uid") String providerUid,
        String state,
        @JsonProperty("created_at") long createdAt,
        @JsonProperty("expires_at") Long expiresAt
) {}
