package dev.realmid.sdk.tenants;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * SPEC §6.8 — result of {@link DriftReviewsClient#reject} /
 * {@link DriftReviewsClient#rejectHard} (ADR-080 Part 3).
 *
 * <p>{@code mode} is {@code "soft"} (the default: dismiss the asserted change,
 * keep the account and its binding, notify the owner) or {@code "hard"} (park
 * the account by severing its provider binding). {@code parked} and
 * {@code revokedBindings} are populated only on a hard reject (0/false
 * otherwise). The pre-ADR-080 {@code new_user_id}/{@code original_value} fields
 * are gone.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record DriftRejectResult(
        String id,
        String status,
        String mode,
        boolean parked,
        @JsonProperty("revoked_bindings") long revokedBindings
) {}
