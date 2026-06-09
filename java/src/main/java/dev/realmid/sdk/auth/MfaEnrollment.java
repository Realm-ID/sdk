package dev.realmid.sdk.auth;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/**
 * Result of {@link AuthClient#enrollMfa(SelfEnrollMfaRequest)} (ADR-061).
 *
 * <p>Wire shape (snake_case):
 * {@code { "secret": string, "qr_url": string, "recovery_codes": [string],
 * "mfa_challenge_token": string, "tenant_id": string }}.
 *
 * <p>{@code mfaChallengeToken} is an enroll-scoped challenge the caller passes
 * to {@link AuthClient#mfaVerify(MFAVerifyRequest)} to confirm the secret AND
 * mint tokens in a single code entry — there is no separate confirm step.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record MfaEnrollment(
        String secret,
        @JsonProperty("qr_url") @JsonAlias("qrUrl") String qrUrl,
        @JsonProperty("recovery_codes") @JsonAlias("recoveryCodes") List<String> recoveryCodes,
        @JsonProperty("mfa_challenge_token") @JsonAlias("mfaChallengeToken") String mfaChallengeToken,
        @JsonProperty("tenant_id") @JsonAlias("tenantId") String tenantId) {
}
