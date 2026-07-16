package dev.realmid.sdk.tenants;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import java.util.List;

/**
 * Response from {@link UsersClient#importUsers} (ADR-073 Release B). The call
 * always resolves HTTP 200 (ADR-069 uniform-200) — inspect {@code committed},
 * not the status code. When {@code committed} is false, validation rejected the
 * file and NOTHING was written; each failing row carries {@code error} +
 * {@code errorHint}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record ImportUsersResult(
        boolean committed,
        int imported,
        int updated,
        int failed,
        List<ImportUserRowResult> rows) {}
