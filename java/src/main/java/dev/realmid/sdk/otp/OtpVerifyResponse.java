package dev.realmid.sdk.otp;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/** Response from {@link OtpClient#verify(OtpVerifyRequest)} (SPEC §X.3). */
@JsonIgnoreProperties(ignoreUnknown = true)
public record OtpVerifyResponse(
        @JsonProperty("otp_id") @JsonAlias("otpId") String otpId,
        @JsonProperty("issuer_user_id") @JsonAlias("issuerUserId") String issuerUserId,
        @JsonProperty("issued_at") @JsonAlias("issuedAt") String issuedAt,
        @JsonProperty("subject_ref") @JsonAlias("subjectRef") String subjectRef,
        String purpose) {}
