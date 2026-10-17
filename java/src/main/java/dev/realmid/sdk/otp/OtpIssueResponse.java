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
        @JsonProperty("subject_ref") @JsonAlias("subjectRef") String subjectRef,
        /**
         * The transport that ran when RealmID delivered the code ("email", "sms", "whatsapp");
         * {@code null} for view_bff, where {@code value} is set instead. For sms/whatsapp a 200
         * means the provider ACCEPTED the message, not that it arrived (ADR-115).
         */
        String delivered) {

    /** Pre-ADR-115 constructor: no delivered echo. */
    public OtpIssueResponse(String id, String value, String expiresAt, String purpose, String subjectRef) {
        this(id, value, expiresAt, purpose, subjectRef, null);
    }

    /** Never prints a credential. */
    @Override
    public String toString() {
        return "OtpIssueResponse[id=" + id + ", expiresAt=" + expiresAt + ", purpose=" + purpose + ", subjectRef=" + subjectRef + "]";
    }
}
