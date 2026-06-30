package dev.realmid.sdk.idp;

import java.util.List;
import java.util.Map;

/**
 * POST body for {@code /identity-providers}. {@code platform_id} is injected
 * by the client (= the realm's own id) and is NOT a field here.
 *
 * <p>{@code tenantId} (optional) scopes the provider to a tenant within the
 * realm. {@code allowedOrigins} is REQUIRED non-empty when
 * {@code clientType == "web"} and must be absent/empty otherwise (server
 * enforced; the SDK passes through).
 *
 * <p>{@code config} carries the provider's PUBLIC config (never secrets) —
 * e.g. the Firebase web config ({@code apiKey}, {@code authDomain},
 * {@code projectId}, {@code appId}). It is echoed verbatim on public
 * discovery; omit for plain OIDC.
 */
public record IdpConfigCreate(String tenantId, String provider, String clientType,
                              String clientId, List<String> allowedOrigins, String comments,
                              Map<String, String> config) {

    /** Backward-compatible constructor without provider config. */
    public IdpConfigCreate(String tenantId, String provider, String clientType,
                           String clientId, List<String> allowedOrigins, String comments) {
        this(tenantId, provider, clientType, clientId, allowedOrigins, comments, null);
    }

    /** Minimal non-web provider (no allowed origins). */
    public static IdpConfigCreate of(String provider, String clientType, String clientId) {
        return new IdpConfigCreate(null, provider, clientType, clientId, null, null, null);
    }
}
