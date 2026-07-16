package dev.realmid.sdk.tenants;

import java.util.List;

/**
 * Create payload for {@code realm.tenants().create(...)} (SPEC §6.1).
 *
 * <p>The realm is implicit (the API key's realm); the wire call is
 * {@code POST /platforms/{realmId}/tenants} with body
 * {@code {display_name, allowed_domains?, signup_mode?}}. {@code signupMode}
 * defaults to {@code "closed"} server-side (ADR-045).
 */
public record TenantCreate(String displayName, List<String> allowedDomains, String signupMode) {
    public static TenantCreate of(String displayName) {
        return new TenantCreate(displayName, null, null);
    }
    public static TenantCreate of(String displayName, List<String> allowedDomains) {
        return new TenantCreate(displayName, allowedDomains, null);
    }
}
