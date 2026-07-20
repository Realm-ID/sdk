package dev.realmid.sdk.sessions;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Result of {@link SessionsClient#revokeUser} / {@link SessionsClient#revokeAll}:
 * how many sessions the revocation touched. {@code status} is {@code "ok"}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record SessionRevokeResult(String status, long revoked) {}
