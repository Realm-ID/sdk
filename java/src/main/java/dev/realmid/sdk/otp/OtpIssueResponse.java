package dev.realmid.sdk.otp;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/** Response from {@link OtpClient#issue(OtpIssueRequest)} (SPEC §X.1). */
@JsonIgnoreProperties(ignoreUnknown = true)
public record OtpIssueResponse(
        String id,
        String value,
        @JsonProperty("expires_at") @JsonAlias("expiresAt") String expiresAt,
        String purpose,
        @JsonProperty("subject_ref") @JsonAlias("subjectRef") String subjectRef) {

    /** Never prints a credential. */
    @Override
    public String toString() {
        return "OtpIssueResponse[id=" + id + ", expiresAt=" + expiresAt + ", purpose=" + purpose + ", subjectRef=" + subjectRef + "]";
    }
}
