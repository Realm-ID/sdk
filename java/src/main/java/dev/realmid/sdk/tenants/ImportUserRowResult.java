package dev.realmid.sdk.tenants;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Per-row report entry in an {@link ImportUsersResult} (ADR-073 Release B).
 *
 * @param line       1-based row index.
 * @param userId     bring-your-own or minted-and-returned {@code users.id}.
 * @param identifier the row's resolved identifier.
 * @param status     one of {@code created|updated|failed|ok}.
 * @param error      error code when the row failed.
 * @param errorHint  human hint when the row failed.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record ImportUserRowResult(
        int line,
        @JsonProperty("user_id") @JsonAlias("userId") String userId,
        String identifier,
        String status,
        String error,
        @JsonProperty("error_hint") @JsonAlias("errorHint") String errorHint) {}
