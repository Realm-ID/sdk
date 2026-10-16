package dev.realmid.sdk.tenants;

import java.time.Instant;

/**
 * Result of {@link UsersClient#sendPasswordReset} (SPEC 6.3). {@code to} is MASKED by the issuer
 * (first character + domain); show it as-is and never try to unmask it.
 */
public record PasswordResetSent(String status, String to, Instant expiresAt) {}
