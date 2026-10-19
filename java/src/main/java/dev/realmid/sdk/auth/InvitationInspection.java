package dev.realmid.sdk.auth;

import java.time.Instant;

/**
 * Answer of {@link AuthClient#inspectInvitation} (ADR-117 D6): the org a sign-up link belongs to
 * and when it lapses. Nothing is consumed by asking.
 */
public record InvitationInspection(String tenantId, String tenantDisplayName, Instant expiresAt) {}
