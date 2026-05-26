package dev.realmid.sdk.auth;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/**
 * Result of {@link AuthClient#enrollMfa(EnrollMfaRequest)}.
 *
 * <p>Wire shape (snake_case):
 * {@code { "secret": string, "qr_url": string, "recovery_codes": [string] }}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record MfaEnrollment(
        String secret,
        @JsonProperty("qr_url") @JsonAlias("qrUrl") String qrUrl,
        @JsonProperty("recovery_codes") @JsonAlias("recoveryCodes") List<String> recoveryCodes) {
}
