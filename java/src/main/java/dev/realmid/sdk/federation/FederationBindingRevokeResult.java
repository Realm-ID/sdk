package dev.realmid.sdk.federation;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/** Response from {@link FederationBindingsClient#revoke} (ADR-057). */
@JsonIgnoreProperties(ignoreUnknown = true)
public record FederationBindingRevokeResult(String status, String id) {}
