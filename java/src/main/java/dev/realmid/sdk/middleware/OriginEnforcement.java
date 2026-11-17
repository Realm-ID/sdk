package dev.realmid.sdk.middleware;

/**
 * The Origin guard on the login, refresh, MFA-verify and recovery routes (SPEC 10.5).
 * {@link #AUTO} (default) enforces iff the realm's {@code origin_enforcement} policy is
 * {@code required}; {@link #ON} and {@link #OFF} force it regardless of the policy.
 */
public enum OriginEnforcement { AUTO, ON, OFF }
