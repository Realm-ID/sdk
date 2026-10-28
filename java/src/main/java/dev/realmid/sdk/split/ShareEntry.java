package dev.realmid.sdk.split;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * One split key's public half plus the partner's private share (SPEC 14.5). {@code n}, {@code e} and
 * {@code dPartner} are base64url big-endian integers. {@link #toString()} redacts the share, so a
 * bundle logged by accident prints a placeholder; JSON encoding (the custody store's own) is unaffected.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record ShareEntry(@JsonProperty("n") String n, @JsonProperty("e") String e,
                         @JsonProperty("d_partner") String dPartner) {

    @Override
    public String toString() {
        return "ShareEntry{n=" + n + " e=" + e + " dPartner=[redacted]}";
    }
}
