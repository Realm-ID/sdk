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
     * Mints a key for {@code userId}, which MUST be the caller — keys are
     * self-service, with no override: an admin minting a credential that
     * authenticates AS a member is impersonation by another name, and ADR-039
     * is deliberately unbuilt.
     *
     * <p>ADR-091 removed the {@code user_api_keys.admin_mint_allowed} escape
     * hatch entirely. It is no longer a config key; PATCHing it answers
     * {@code 400 unknown_config_key}.
     *
     * <p>The returned {@code value} is shown ONCE. Persist it at the call site or
     * it is gone.
     */
    public UserAPIKey create(String tenantId, String userId, UserAPIKeyWrite body) {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "POST", path(tenantId, userId)).body(writeBody(body)));
        return http.mapper().convertValue(raw, UserAPIKey.class);
    }

    /**
     * Replaces a key in place (ADR-100 D12) — cap, label, org scope and TTL. The
     * key's SECRET is untouched: {@code update} never re-issues plaintext and the
     * returned key carries no {@code value}.
     *
     * <p><b>⚠️ This is a PUT: it resets what it omits.</b> Read the key, change
     * the one field, send the whole shape back. See {@link UserAPIKeyWrite}.
     *
     * <p>Widening — {@code uncapped} FALSE→TRUE, adding permissions,
     * {@code orgScope} selected→all, extending the TTL — is gated by the same MFA
     * step-up as the mint ({@code user_api_keys.require_mfa_at_mint}). It has to
     * be: a key minted narrowly and then widened through an unguarded update
     * would make the mint's gate decorative.
     *
     * <p>A cap change takes effect at the NEXT token mint. Access tokens already
     * issued keep the bound they were minted with until they expire.
     */
    public UserAPIKey update(String tenantId, String userId, String id, UserAPIKeyWrite body) {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "PUT", path(tenantId, userId) + "/" + enc(id)).body(writeBody(body)));
        return http.mapper().convertValue(raw, UserAPIKey.class);
    }

    /**
     * The one place the write shape is serialised, so create and update cannot
     * drift apart.
     *
     * <p>{@code uncapped} is put UNCONDITIONALLY, unlike every neighbour here. An
     * omitted {@code uncapped} is exactly the wire shape ADR-100 exists to make
     * illegal, so letting it fall out of a null guard — the idiom this class uses
     * everywhere else, and which {@code IntegrationsClient} uses for a boolean —
     * would rebuild the bug inside the SDK. A null therefore travels as JSON
     * null and earns a {@code 400}, which is louder and better than a default.
     */
    private static Map<String, Object> writeBody(UserAPIKeyWrite body) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("label", body.label());
        if (body.orgScope() != null) b.put("org_scope", body.orgScope());
        if (body.orgIds() != null) b.put("org_ids", body.orgIds());
        b.put("uncapped", body.uncapped());
        if (body.permissionsCap() != null) b.put("permissions_cap", body.permissionsCap());
        if (body.ttlSeconds() != null) b.put("ttl_seconds", body.ttlSeconds());
        return b;
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
