package dev.realmid.sdk.auth;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/**
 * Response from {@link AuthClient#regenerateRecoveryCodes}: the fresh set of
 * one-time recovery codes, shown once. The previous set (including any
 * still-unconsumed codes) is invalidated. {@code status} is {@code "ok"}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record RecoveryCodes(
        String status,
        @JsonProperty("recovery_codes") List<String> recoveryCodes
) {}
