package dev.realmid.sdk.idp;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.http.HttpTransport;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Public identity-provider discovery (SPEC §6.10) — the platform-token-authed
 * endpoint a partner backend calls to populate its login provider list.
 * Distinct from the realm-admin IdP config CRUD in
 * {@link IdentityProviderConfigClient}. Mirrors the Go SDK's
 * {@code Realm.IdentityProviders}.
 */
public final class IdentityProvidersClient {
    private final HttpTransport http;
    private final String realmId;

    public IdentityProvidersClient(HttpTransport http, String realmId) {
        this.http = http;
        this.realmId = realmId;
    }

    /** Discover with issuer defaults (web, realm-scope). */
    public IdentityProvidersResponse discover() { return discover(null); }

    /**
     * Discover the realm's (or a tenant's) enabled identity providers. Wraps
     * GET /platforms/{realmId}/identity-providers; the realm's platform token
     * is attached automatically. {@code opts} may be null.
     */
    public IdentityProvidersResponse discover(IdentityProvidersOptions opts) {
        Map<String, Object> q = new LinkedHashMap<>();
        if (opts != null && opts.platform() != null) q.put("platform", opts.platform());
        if (opts != null && opts.tenantId() != null) q.put("tenant_id", opts.tenantId());
        HttpTransport.Request req = HttpTransport.Request.of(
                "GET", "/platforms/" + enc(realmId) + "/identity-providers").query(q);
        if (opts != null && opts.origin() != null) req.header("Origin", opts.origin());
        JsonNode raw = http.request(req);
        return http.mapper().convertValue(raw, IdentityProvidersResponse.class);
    }

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }
}
