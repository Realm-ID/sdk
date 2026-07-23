package dev.realmid.sdk.integrations;

/**
 * POST body for {@code /tenants/{id}/integration-installations} (ADR-083 §4.2).
 *
 * <p>{@code roleId} MUST name a role whose {@code assignable_to} is exactly
 * {@code ["service"]} (ADR-082 §7.1); anything else is rejected
 * {@code role_not_service_typed}.
 */
public record InstallRequest(String integrationId, String roleId) {
}
