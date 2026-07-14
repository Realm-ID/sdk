package dev.realmid.sdk.serviceaccounts;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * One {@code kind=service} account (issuer serviceAccountDTO, ADR-071 §2/§10).
 * A service account is a first-class non-human identity that logs in via a
 * {@code view_bff} OTP (never a human provider).
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record ServiceAccount(
        String id,
        /** Email-shaped login handle (contains {@code @}), unique in the tenant. */
        String handle,
        String role,
        String status,
        String kind,
        @JsonProperty("display_name") @JsonAlias("displayName") String displayName,
        @JsonProperty("created_at") @JsonAlias("createdAt") String createdAt) {
}
