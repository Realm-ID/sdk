package dev.realmid.sdk.split;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/** A retired public key still trusted until {@code trustUntil} (epoch seconds, SPEC 14.4). */
@JsonIgnoreProperties(ignoreUnknown = true)
public record PreviousKey(@JsonProperty("kid") String kid, @JsonProperty("n") String n,
                          @JsonProperty("e") String e, @JsonProperty("trust_until") long trustUntil) {}
