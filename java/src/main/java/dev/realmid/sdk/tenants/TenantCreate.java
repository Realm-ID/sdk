package dev.realmid.sdk.tenants;

import java.util.Map;

public record TenantCreate(String displayName, String ownerUserId, Map<String, Object> config) {
    public static TenantCreate of(String displayName) {
        return new TenantCreate(displayName, null, null);
    }
    public static TenantCreate of(String displayName, String ownerUserId) {
        return new TenantCreate(displayName, ownerUserId, null);
    }
}
