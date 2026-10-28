package dev.realmid.sdk.tenants;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/** The owner as the issuer returns it seated on a created tenant (R83, SPEC 14.11): role is {@code owner}. */
@JsonIgnoreProperties(ignoreUnknown = true)
public record TenantOwnerSeat(String id, String email, String role) {}
