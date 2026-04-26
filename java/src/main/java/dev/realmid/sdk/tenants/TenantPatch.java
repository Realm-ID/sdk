package dev.realmid.sdk.tenants;

public record TenantPatch(String displayName) {
    public static TenantPatch of(String displayName) { return new TenantPatch(displayName); }
}
