package dev.realmid.sdk.auth;

/**
 * Result of {@link AuthClient#sendLoginCode}: the bare 202 body. {@code sentIfRegistered} is
 * ALWAYS true and does not say whether the number belongs to anyone (enumeration-safe by design).
 */
public record SendLoginCodeResponse(boolean sentIfRegistered) {}
