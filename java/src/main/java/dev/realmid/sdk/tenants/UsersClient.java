package dev.realmid.sdk.tenants;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.http.HttpTransport;
import dev.realmid.sdk.pagination.PageReader;
import dev.realmid.sdk.pagination.Paginated;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** SPEC §6.3. */
public final class UsersClient {
    private final HttpTransport http;

    public UsersClient(HttpTransport http) { this.http = http; }

    public Paginated<User> list(String tenantId) {
        return Paginated.of(opts -> {
            Map<String, Object> q = new LinkedHashMap<>();
            if (opts.cursor() != null) q.put("cursor", opts.cursor());
            if (opts.limit() != null) q.put("limit", opts.limit());
            JsonNode raw = http.request(HttpTransport.Request.of(
                    "GET", "/tenants/" + enc(tenantId) + "/users").query(q));
            return PageReader.read(http.mapper(), raw, User.class);
        });
    }

    public User get(String tenantId, String userId) {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "GET", "/tenants/" + enc(tenantId) + "/users/" + enc(userId)));
        return http.mapper().convertValue(raw, User.class);
    }

    public User updateStatus(String tenantId, String userId, UserStatus status) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("status", status.wire());
        JsonNode raw = http.request(HttpTransport.Request.of(
                "PATCH", "/tenants/" + enc(tenantId) + "/users/" + enc(userId) + "/status").body(b));
        return http.mapper().convertValue(raw, User.class);
    }

    public User updateContact(String tenantId, String userId, UpdateContactInput body) {
        Map<String, Object> b = new LinkedHashMap<>();
        if (body.email() != null) b.put("email", body.email());
        if (body.phone() != null) b.put("phone", body.phone());
        JsonNode raw = http.request(HttpTransport.Request.of(
                "PATCH", "/tenants/" + enc(tenantId) + "/users/" + enc(userId)).body(b));
        return http.mapper().convertValue(raw, User.class);
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> enrollMfa(String tenantId, String userId) {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "POST", "/tenants/" + enc(tenantId) + "/users/" + enc(userId) + "/mfa/enroll"));
        return raw == null ? Map.of() : http.mapper().convertValue(raw, Map.class);
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> confirmMfa(String tenantId, String userId, String code) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("code", code);
        JsonNode raw = http.request(HttpTransport.Request.of(
                "POST", "/tenants/" + enc(tenantId) + "/users/" + enc(userId) + "/mfa/confirm").body(b));
        return raw == null ? Map.of() : http.mapper().convertValue(raw, Map.class);
    }

    public void resetMfa(String tenantId, String userId) {
        http.request(HttpTransport.Request.of(
                "DELETE", "/tenants/" + enc(tenantId) + "/users/" + enc(userId) + "/mfa"));
    }

    /**
     * Bulk-import pre-provisioned ACTIVE users into a tenant (ADR-073 Release
     * B, POST /tenants/{id}/users/import). Two-phase, whole-file-atomic on
     * validation: when {@link ImportUsersResult#committed()} is false NOTHING
     * was written and each failing row carries {@code error}+{@code errorHint}.
     * A row may bring its own {@code userId} (becomes {@code users.id}); rows
     * without one get a minted id returned. Always resolves HTTP 200 — inspect
     * {@code committed}, not the status code.
     */
    public ImportUsersResult importUsers(String tenantId, List<ImportUserRow> rows) {
        List<Map<String, Object>> wire = new ArrayList<>();
        for (ImportUserRow r : rows) {
            Map<String, Object> m = new LinkedHashMap<>();
            if (r.userId() != null) m.put("user_id", r.userId());
            if (r.email() != null) m.put("email", r.email());
            if (r.phone() != null) m.put("phone", r.phone());
            if (r.role() != null) m.put("role", r.role());
            if (r.displayName() != null) m.put("display_name", r.displayName());
            if (r.provider() != null) m.put("provider", r.provider());
            if (r.providerUid() != null) m.put("provider_uid", r.providerUid());
            wire.add(m);
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("users", wire);
        JsonNode raw = http.request(HttpTransport.Request.of(
                "POST", "/tenants/" + enc(tenantId) + "/users/import").body(body));
        return http.mapper().convertValue(raw, ImportUsersResult.class);
    }

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }
}
