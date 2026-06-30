package dev.realmid.sdk.idp;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;
import dev.realmid.sdk.http.HttpTransport;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Identity-provider config CRUD (admin resource). Realm-admin authz via the
 * platform token, exactly like {@code RolesClient}; the transport
 * auto-attaches the platform JWT.
 *
 * <p>This is the partner-configurable IdP credential store — distinct from
 * the realm's public IdP <em>discovery</em> surface, which this client does
 * not touch.
 *
 * <p>{@code platform_id} is required by the server but is ALWAYS the realm's
 * own id; this client injects it automatically and callers never pass it. An
 * optional {@code tenantId} scopes a provider to a tenant within the realm.
 *
 * <p>Server error codes ({@code provider_exists} 409,
 * {@code provider_not_found} 404, {@code unsupported_provider},
 * {@code unsupported_client_type}, {@code empty_patch}, {@code bad_request})
 * flow through as {@link RealmException} with the canonical {@link ErrorCode}
 * mapped from the HTTP status; the server's specific code string rides on
 * {@link RealmException#getDetails}.
 */
public final class IdentityProviderConfigClient {

    private final HttpTransport http;
    private final String realmId;

    public IdentityProviderConfigClient(HttpTransport http, String realmId) {
        this.http = http;
        this.realmId = realmId;
    }

    /** GET /identity-providers?platform_id={realmId}[&amp;tenant_id=...]. */
    public IdpConfigListPage list(IdpConfigListOpts opts) {
        Map<String, Object> q = new LinkedHashMap<>();
        q.put("platform_id", realmId);
        if (opts != null && opts.tenantId() != null && !opts.tenantId().isEmpty()) {
            q.put("tenant_id", opts.tenantId());
        }
        JsonNode raw = http.request(HttpTransport.Request.of("GET", "/identity-providers").query(q));
        return readPage(raw);
    }

    public IdpConfigListPage list() { return list(null); }

    /** POST /identity-providers. */
    public IdpConfig create(IdpConfigCreate body) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("platform_id", realmId);
        if (body.tenantId() != null && !body.tenantId().isEmpty()) b.put("tenant_id", body.tenantId());
        b.put("provider", body.provider());
        b.put("client_type", body.clientType());
        b.put("client_id", body.clientId());
        if (body.allowedOrigins() != null) b.put("allowed_origins", body.allowedOrigins());
        if (body.comments() != null) b.put("comments", body.comments());
        if (body.config() != null) b.put("config", body.config());
        JsonNode raw = http.request(HttpTransport.Request.of("POST", "/identity-providers").body(b));
        return http.mapper().convertValue(raw, IdpConfig.class);
    }

    /** PATCH /identity-providers/{id}. */
    public IdpConfig update(String id, IdpConfigPatch patch) {
        Map<String, Object> b = new LinkedHashMap<>();
        if (patch.enabled() != null) b.put("enabled", patch.enabled());
        if (patch.clientId() != null) b.put("client_id", patch.clientId());
        if (patch.allowedOrigins() != null) b.put("allowed_origins", patch.allowedOrigins());
        if (patch.comments() != null) b.put("comments", patch.comments());
        if (patch.config() != null) b.put("config", patch.config());
        JsonNode raw = http.request(HttpTransport.Request.of(
                "PATCH", "/identity-providers/" + enc(id)).body(b));
        return http.mapper().convertValue(raw, IdpConfig.class);
    }

    /** DELETE /identity-providers/{id}. */
    public IdpConfigDeleteResult delete(String id) {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "DELETE", "/identity-providers/" + enc(id)));
        if (raw == null) return new IdpConfigDeleteResult("deleted");
        JsonNode s = raw.get("status");
        return new IdpConfigDeleteResult(s != null && s.isTextual() ? s.asText() : "deleted");
    }

    private IdpConfigListPage readPage(JsonNode raw) {
        if (raw == null || !raw.isObject()) {
            throw new RealmException(ErrorCode.SERVER_ERROR, "unexpected list response shape");
        }
        JsonNode itemsNode = raw.get("items");
        List<IdpConfig> items = new ArrayList<>();
        if (itemsNode != null && itemsNode.isArray()) {
            for (JsonNode n : itemsNode) items.add(http.mapper().convertValue(n, IdpConfig.class));
        }
        return new IdpConfigListPage(items);
    }

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }
}
