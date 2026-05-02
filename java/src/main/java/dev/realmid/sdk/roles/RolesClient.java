package dev.realmid.sdk.roles;

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
 * Realm-defined custom roles surface (ADR-040).
 *
 * <p>Each realm owns a {@code realm_roles} catalog. Only {@code owner}
 * and {@code member} are system roles; everything else is partner-
 * defined per realm. The five CRUD methods below mirror the wire
 * surface in ADR-040 §Wire surface.
 *
 * <p>Server-specific error codes ({@code role_in_use},
 * {@code system_role_immutable}, {@code role_exists},
 * {@code unknown_role}) flow through as {@link RealmException} with the
 * canonical {@link ErrorCode} mapped from the HTTP status. The
 * server's role-specific code string is preserved on
 * {@link RealmException#getDetails} (e.g. as {@code details.get("code")}
 * when the server returns the flat envelope, otherwise inside the
 * {@code error} sibling).
 */
public final class RolesClient {

    private final HttpTransport http;
    private final String realmId;

    public RolesClient(HttpTransport http, String realmId) {
        this.http = http;
        this.realmId = realmId;
    }

    /** GET /platforms/{id}/roles. */
    public RoleListPage list(RoleListOpts opts) {
        Map<String, Object> q = new LinkedHashMap<>();
        if (opts != null) {
            if (opts.cursor() != null) q.put("cursor", opts.cursor());
            if (opts.limit() != null) q.put("limit", opts.limit());
        }
        JsonNode raw = http.request(HttpTransport.Request.of(
                "GET", "/platforms/" + enc(realmId) + "/roles").query(q));
        return readPage(raw);
    }

    public RoleListPage list() { return list(null); }

    /** POST /platforms/{id}/roles. */
    public RoleObject create(RoleCreate body) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("name", body.name());
        if (body.displayName() != null) b.put("display_name", body.displayName());
        if (body.permissions() != null) b.put("permissions", body.permissions());
        JsonNode raw = http.request(HttpTransport.Request.of(
                "POST", "/platforms/" + enc(realmId) + "/roles").body(b));
        return http.mapper().convertValue(raw, RoleObject.class);
    }

    /** PATCH /platforms/{id}/roles/{roleId}. */
    public RoleObject update(String roleId, RolePatch patch) {
        Map<String, Object> b = new LinkedHashMap<>();
        if (patch.displayName() != null) b.put("display_name", patch.displayName());
        if (patch.permissions() != null) b.put("permissions", patch.permissions());
        JsonNode raw = http.request(HttpTransport.Request.of(
                "PATCH", "/platforms/" + enc(realmId) + "/roles/" + enc(roleId)).body(b));
        return http.mapper().convertValue(raw, RoleObject.class);
    }

    /** DELETE /platforms/{id}/roles/{roleId}. */
    public RoleDeleteResult delete(String roleId) {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "DELETE", "/platforms/" + enc(realmId) + "/roles/" + enc(roleId)));
        if (raw == null) return new RoleDeleteResult("deleted");
        JsonNode s = raw.get("status");
        return new RoleDeleteResult(s != null && s.isTextual() ? s.asText() : "deleted");
    }

    /** POST /platforms/{id}/roles/{roleId}/rename. */
    public RoleObject rename(String roleId, String to) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("to", to);
        JsonNode raw = http.request(HttpTransport.Request.of(
                "POST", "/platforms/" + enc(realmId) + "/roles/" + enc(roleId) + "/rename").body(b));
        return http.mapper().convertValue(raw, RoleObject.class);
    }

    private RoleListPage readPage(JsonNode raw) {
        if (raw == null || !raw.isObject()) {
            throw new RealmException(ErrorCode.SERVER_ERROR, "unexpected paginated response shape");
        }
        JsonNode itemsNode = raw.get("items");
        if (itemsNode == null || !itemsNode.isArray()) {
            throw new RealmException(ErrorCode.SERVER_ERROR, "unexpected paginated response shape");
        }
        List<RoleObject> items = new ArrayList<>(itemsNode.size());
        for (JsonNode n : itemsNode) items.add(http.mapper().convertValue(n, RoleObject.class));
        String nextCursor = null;
        JsonNode nc = raw.get("next_cursor");
        if (nc != null && !nc.isNull() && nc.isTextual() && !nc.asText().isEmpty()) {
            nextCursor = nc.asText();
        }
        Long total = null;
        JsonNode t = raw.get("total");
        if (t != null && t.isNumber()) total = t.asLong();
        return new RoleListPage(items, nextCursor, total);
    }

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }
}
