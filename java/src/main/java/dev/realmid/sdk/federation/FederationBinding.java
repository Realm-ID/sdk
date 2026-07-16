package dev.realmid.sdk.federation;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;
import java.util.Map;

/**
 * A workload-identity-federation trust binding (ADR-057). A workload OIDC
 * assertion is accepted as a bootstrap credential for this platform iff its
 * {@code iss} matches {@code issuer}, its {@code aud} matches {@code audience},
 * and every {@code matchClaims} entry equals the corresponding assertion claim.
 * {@code lastUsedAt}/{@code createdAt} are unix seconds.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record FederationBinding(
        String id,
        @JsonProperty("platform_id") @JsonAlias("platformId") String platformId,
        @JsonProperty("realm_id") @JsonAlias("realmId") String realmId,
        String issuer,
        String audience,
        @JsonProperty("match_claims") @JsonAlias("matchClaims") Map<String, String> matchClaims,
        @JsonProperty("mapped_role") @JsonAlias("mappedRole") String mappedRole,
        List<String> scope,
        String status,
        @JsonProperty("last_used_at") @JsonAlias("lastUsedAt") Long lastUsedAt,
        @JsonProperty("created_at") @JsonAlias("createdAt") Long createdAt) {}
