package dev.realmid.sdk.idp;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.Map;

/**
 * One row from the public identity-provider discovery endpoint (SPEC §6.10).
 * Admin-only fields are stripped, leaving the minimum a SPA needs to render its
 * login provider list.
 *
 * @param type       provider name (google|microsoft|firebase|facebook|apple).
 * @param clientType client surface (web|ios|android|desktop|other).
 * @param clientId   the provider client id for this scope.
 * @param config     provider PUBLIC config (e.g. the Firebase web config);
 *        absent when empty.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record PublicIdentityProvider(
        String type,
        @JsonProperty("client_type") @JsonAlias("clientType") String clientType,
        @JsonProperty("client_id") @JsonAlias("clientId") String clientId,
        Map<String, String> config) {}
