package dev.realmid.sdk.serviceaccounts;

/**
 * POST body for {@code /tenants/{id}/service-accounts} (ADR-071).
 *
 * <p>{@code handle} is the email-shaped login handle (must contain {@code @}),
 * unique in the tenant. {@code role} must not be {@code owner} or
 * {@code platform_api}; null defaults to {@code member}. {@code displayName}
 * is optional and defaults to the handle.
 */
public record ServiceAccountCreate(String handle, String role, String displayName) {

    public ServiceAccountCreate(String handle) { this(handle, null, null); }

    public ServiceAccountCreate(String handle, String role) { this(handle, role, null); }
}
