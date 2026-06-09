package dev.realmid.sdk.auth;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * SPEC §4.2 response.
 *
 * <p>{@code subjectType} is the minted token's subject class (ADR-051):
 * {@code "user"}, {@code "service"}, or {@code "platform"}. The issuer
 * returns it on {@code POST /auth/token} for every refresh class;
 * {@code tenantId} and {@code role} are populated only when
 * {@code subjectType} is {@code "user"}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record TokenResponse(
        @JsonProperty("access_token") @JsonAlias("accessToken") String accessToken,
        @JsonProperty("refresh_token") @JsonAlias("refreshToken") String refreshToken,
        @JsonProperty("expires_in") @JsonAlias("expiresIn") long expiresIn,
        @JsonProperty("subject_type") @JsonAlias("subjectType") String subjectType,
        @JsonProperty("tenant_id") @JsonAlias("tenantId") String tenantId,
        String role
) {}
