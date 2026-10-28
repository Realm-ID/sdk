package dev.realmid.sdk.split;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;
import java.util.Map;

/** The partner's share bundle: {@code {realm, shares: {kid: entry}, previous: [...]}} (SPEC 14.5). */
@JsonIgnoreProperties(ignoreUnknown = true)
public record ShareBundle(@JsonProperty("realm") String realm,
                          @JsonProperty("shares") Map<String, ShareEntry> shares,
                          @JsonProperty("previous") @JsonInclude(JsonInclude.Include.NON_EMPTY) List<PreviousKey> previous) {}
