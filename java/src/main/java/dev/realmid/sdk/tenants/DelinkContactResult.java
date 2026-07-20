package dev.realmid.sdk.tenants;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Result of {@link UsersClient#delinkContact} (ADR-080 Part 2): the contact
 * whose provider binding was severed and how many active
 * {@code contact_verifications} rows were revoked. {@code status} is
 * {@code "delinked"}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record DelinkContactResult(
        String status,
        @JsonProperty("contact_id") String contactId,
        @JsonProperty("revoked_bindings") long revokedBindings
) {}
