package dev.realmid.sdk.auth;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * One enrolled MFA factor returned by {@link AuthClient#listAuthenticators}.
 * Today only TOTP is supported, so the list has 0 or 1 entries; the shape is
 * forward-compatible with multiple factors. {@code createdAt}/{@code confirmedAt}
 * are unix seconds ({@code confirmedAt} is 0 until confirmed).
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record Authenticator(
        String type,
        boolean confirmed,
        @JsonProperty("created_at") long createdAt,
        @JsonProperty("confirmed_at") long confirmedAt
) {}
