package dev.realmid.sdk.auth;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/** Result of {@link AuthClient#mintMfaChallenge(String)}. */
@JsonIgnoreProperties(ignoreUnknown = true)
public record MFAChallenge(
        @JsonProperty("mfa_challenge_token") @JsonAlias("mfaChallengeToken") String mfaChallengeToken,
        List<String> methods
) {}
