package dev.realmid.sdk.auth;

import java.time.Instant;

/**
 * Result of {@link AuthClient#inspectPasswordReset} (ADR-111, SPEC 4.10). A 200 is not a
 * reservation: the token can still expire or be used before
 * {@link AuthClient#consumePasswordReset} runs.
 */
public record PasswordResetInspection(Instant expiresAt) {}
