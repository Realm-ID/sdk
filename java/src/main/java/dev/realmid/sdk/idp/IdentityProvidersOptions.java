package dev.realmid.sdk.idp;

/**
 * Tunes {@link IdentityProvidersClient#discover} (all optional).
 *
 * @param platform narrows discovery to a client surface
 *        (web|ios|android|desktop|other); null defers to the issuer default.
 * @param tenantId pins discovery to a specific tenant on this realm; null →
 *        Origin resolution (if any) or realm-scope.
 * @param origin   rides as the Origin header so the issuer's domain-mappings
 *        lookup can resolve a tenant from the caller's SPA origin (ADR-047).
 */
public record IdentityProvidersOptions(String platform, String tenantId, String origin) {
    public static IdentityProvidersOptions empty() { return new IdentityProvidersOptions(null, null, null); }
    public static IdentityProvidersOptions forPlatform(String platform) {
        return new IdentityProvidersOptions(platform, null, null);
    }
}
