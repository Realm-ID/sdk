package dev.realmid.sdk.idp;

/**
 * Options for {@link IdentityProviderConfigClient#list(IdpConfigListOpts)}.
 * {@code tenantId} (optional) scopes the listing to one tenant within the
 * realm. {@code platform_id} is always injected by the client.
 */
public record IdpConfigListOpts(String tenantId) {

    public static IdpConfigListOpts forTenant(String tenantId) {
        return new IdpConfigListOpts(tenantId);
    }
}
