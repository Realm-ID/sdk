package dev.realmid.sdk.roles;

/**
 * A grantable permission from the fixed ADR-074 catalog, as returned by
 * {@code GET /platforms/{id}/permissions}. These gate RI admin-console
 * operations for the platform — not the partner's own product RBAC.
 *
 * @param key      the {@code resource:action} permission string (e.g. {@code users:manage})
 * @param resource the resource group (e.g. {@code users})
 * @param action   the action (e.g. {@code manage})
 * @param label    a human-readable label for UI rendering
 */
public record Permission(String key, String resource, String action, String label) {}
