package dev.realmid.sdk.otp;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/** Response from {@link OtpClient#view(String, OtpViewOptions)} (SPEC §X.2). */
@JsonIgnoreProperties(ignoreUnknown = true)
public record OtpViewResponse(
        String id,
        String value,
        @JsonProperty("expires_at") @JsonAlias("expiresAt") String expiresAt,
        String purpose,
        @JsonProperty("subject_ref") @JsonAlias("subjectRef") String subjectRef,
        @JsonProperty("issuer_user_id") @JsonAlias("issuerUserId") String issuerUserId) {}
