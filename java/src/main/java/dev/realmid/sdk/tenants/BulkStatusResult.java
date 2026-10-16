package dev.realmid.sdk.tenants;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/**
 * Response of {@code POST /tenants/{id}/users/bulk-status}. One refused id does
 * not fail the call; inspect each row's outcome.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record BulkStatusResult(List<Row> results) {
    public BulkStatusResult {
        results = results == null ? List.of() : List.copyOf(results);
    }

    /** @param outcome raw wire string; use {@link #outcomeKind()} for the enum. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Row(@JsonProperty("user_id") String userId, String outcome) {
        @JsonIgnore
        public BulkStatusOutcome outcomeKind() { return BulkStatusOutcome.fromWire(outcome); }
    }
}
