package dev.realmid.sdk.userapikeys;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.http.HttpTransport;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** SPEC §6.6 — end-user API keys (ADR-084). */
public final class UserAPIKeysClient {

    private final HttpTransport http;

    public UserAPIKeysClient(HttpTransport http) {
        this.http = http;
    }

    /**
     * Mints a key for {@code userId}, which must be the caller unless the realm
     * sets {@code user_api_keys.admin_mint_allowed} (default false — an admin
     * minting a credential that authenticates AS a member is impersonation by
     * another name, and ADR-039 is deliberately unbuilt).
     *
     * <p>The returned {@code value} is shown ONCE. Persist it at the call site or
     * it is gone.
     */
    public UserAPIKey create(String tenantId, String userId, UserAPIKeyCreate body) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("label", body.label());
        if (body.orgScope() != null) b.put("org_scope", body.orgScope());
        if (body.orgIds() != null) b.put("org_ids", body.orgIds());
        if (body.permissionsCap() != null) b.put("permissions_cap", body.permissionsCap());
        if (body.ttlSeconds() != null) b.put("ttl_seconds", body.ttlSeconds());
        JsonNode raw = http.request(HttpTransport.Request.of(
                "POST", path(tenantId, userId)).body(b));
        return http.mapper().convertValue(raw, UserAPIKey.class);
    }

    /**
     * Lists every key for {@code userId}, INCLUDING revoked and expired ones —
     * the surface shows them and callers filter as needed. Never returns
     * plaintext.
     */
    public List<UserAPIKey> list(String tenantId, String userId) {
        JsonNode raw = http.request(HttpTransport.Request.of("GET", path(tenantId, userId)));
        if (raw == null) return List.of();
        JsonNode arr = raw.isArray() ? raw : raw.get("items");
        if (arr == null || !arr.isArray()) return List.of();
        List<UserAPIKey> out = new ArrayList<>(arr.size());
        for (JsonNode n : arr) out.add(http.mapper().convertValue(n, UserAPIKey.class));
        return out;
    }

    /** Soft revoke. Idempotent. */
    public void revoke(String tenantId, String userId, String id) {
        http.request(HttpTransport.Request.of(
                "DELETE", path(tenantId, userId) + "/" + enc(id)));
    }

    private static String path(String tenantId, String userId) {
        return "/tenants/" + enc(tenantId) + "/users/" + enc(userId) + "/user-api-keys";
    }

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }
}
