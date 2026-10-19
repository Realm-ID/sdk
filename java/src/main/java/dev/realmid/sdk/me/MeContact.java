package dev.realmid.sdk.me;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * One of the caller's own active contacts — an item of {@link MeClient#listContacts}. The wire
 * carries exactly these five fields; {@code id} is the one {@link MeClient#sendContactProof} takes,
 * {@code kind} is {@code "email"} or {@code "phone"}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record MeContact(
        @JsonProperty("id") String id,
        @JsonProperty("kind") String kind,
        @JsonProperty("value") String value,
        @JsonProperty("verified") boolean verified,
        @JsonProperty("tenant_id") String tenantId) {
    /** Omits {@code value}: an address or phone number is personal data and does not belong in a log line. */
    @Override
    public String toString() {
        return "MeContact[id=" + id + ", kind=" + kind + ", verified=" + verified + ", tenantId=" + tenantId + "]";
    }
}
