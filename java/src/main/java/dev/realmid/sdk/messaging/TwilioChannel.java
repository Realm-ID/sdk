package dev.realmid.sdk.messaging;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * The SMS save body (SPEC 6.16): the realm's own Twilio account.
 *
 * <p>Give EXACTLY ONE auth form ({@code authToken}, or {@code apiKeySid} with {@code apiKeySecret};
 * an API key is preferred, being revocable on its own) and EXACTLY ONE sender form
 * ({@code fromNumber} in strict E.164, or {@code messagingServiceSid}). The issuer enforces both
 * rules: a violation is {@code 400 invalid_channel_config} naming the field. Unset fields are not sent.
 *
 * <p>{@code authToken} and {@code apiKeySecret} are WRITE-ONLY and never appear in
 * {@link #toString()}; no read type carries one.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record TwilioChannel(
        @JsonProperty("account_sid") String accountSid,
        @JsonProperty("auth_token") String authToken,
        @JsonProperty("api_key_sid") String apiKeySid,
        @JsonProperty("api_key_secret") String apiKeySecret,
        @JsonProperty("from_number") String fromNumber,
        @JsonProperty("messaging_service_sid") String messagingServiceSid) {

    /** Never prints a credential. */
    @Override
    public String toString() {
        return "TwilioChannel[accountSid=" + accountSid + ", apiKeySid=" + apiKeySid
                + ", fromNumber=" + fromNumber + ", messagingServiceSid=" + messagingServiceSid
                + ", authToken=" + (authToken == null ? "unset" : "***")
                + ", apiKeySecret=" + (apiKeySecret == null ? "unset" : "***") + "]";
    }

    public static Builder builder() { return new Builder(); }

    /** Fluent builder; every field is optional here, the issuer enforces the exactly-one-of rules. */
    public static final class Builder {
        private String accountSid, authToken, apiKeySid, apiKeySecret, fromNumber, messagingServiceSid;

        public Builder accountSid(String v) { this.accountSid = v; return this; }
        /** WRITE-ONLY. */
        public Builder authToken(String v) { this.authToken = v; return this; }
        public Builder apiKeySid(String v) { this.apiKeySid = v; return this; }
        /** WRITE-ONLY. */
        public Builder apiKeySecret(String v) { this.apiKeySecret = v; return this; }
        public Builder fromNumber(String v) { this.fromNumber = v; return this; }
        public Builder messagingServiceSid(String v) { this.messagingServiceSid = v; return this; }

        public TwilioChannel build() {
            return new TwilioChannel(accountSid, authToken, apiKeySid, apiKeySecret, fromNumber, messagingServiceSid);
        }
    }
}
