package dev.realmid.sdk.idp;

import java.util.List;

/**
 * POST body for {@code /identity-providers}. {@code platform_id} is injected
 * by the client (= the realm's own id) and is NOT a field here.
 *
 * <p>{@code tenantId} (optional) scopes the provider to a tenant within the
 * realm. {@code allowedOrigins} is REQUIRED non-empty when
 * {@code clientType == "web"} and must be absent/empty otherwise (server
 * enforced; the SDK passes through).
 */
public record IdpConfigCreate(String tenantId, String provider, String clientType,
                              String clientId, List<String> allowedOrigins, String comments) {

    /** Minimal non-web provider (no allowed origins). */
    public static IdpConfigCreate of(String provider, String clientType, String clientId) {
        return new IdpConfigCreate(null, provider, clientType, clientId, null, null);
    }
}
