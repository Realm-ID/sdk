package dev.realmid.sdk.tenants;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/** SPEC §6.9 — result of {@link ContactVerificationsClient#approve}/{@link ContactVerificationsClient#reject}. */
@JsonIgnoreProperties(ignoreUnknown = true)
public record ContactVerificationResult(
        String id,
        String state
) {}
