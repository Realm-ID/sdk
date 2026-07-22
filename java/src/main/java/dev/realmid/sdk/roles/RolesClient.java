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
 * defined per realm. The CRUD methods below mirror the wire surface in
 * ADR-040 §Wire surface; {@link #disable}/{@link #enable} soft-toggle a
 * role's availability (roles/signing-keys overhaul).
 *
 * <p>Server-specific error codes ({@code role_in_use},
 * {@code system_role_immutable}, {@code role_exists},
 * {@code unknown_role}, {@code role_protected}, {@code last_active_role},
 * {@code role_is_default}) flow through as {@link RealmException} with the
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
            if (opts.includeSystem()) q.put("include_system", "true");
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
        if (body.requiredMfaMethods() != null) b.put("required_mfa_methods", body.requiredMfaMethods());
        if (body.canInviteRoles() != null) b.put("can_invite_roles", body.canInviteRoles());
        if (body.assignableTo() != null) b.put("assignable_to", body.assignableTo());
        JsonNode raw = http.request(HttpTransport.Request.of(
                "POST", "/platforms/" + enc(realmId) + "/roles").body(b));
        return http.mapper().convertValue(raw, RoleObject.class);
    }

    /** PATCH /platforms/{id}/roles/{roleId}. */
    public RoleObject update(String roleId, RolePatch patch) {
        Map<String, Object> b = new LinkedHashMap<>();
        if (patch.displayName() != null) b.put("display_name", patch.displayName());
        if (patch.permissions() != null) b.put("permissions", patch.permissions());
        if (patch.requiredMfaMethods() != null) b.put("required_mfa_methods", patch.requiredMfaMethods());
        if (patch.canInviteRoles() != null) b.put("can_invite_roles", patch.canInviteRoles());
        if (patch.assignableTo() != null) b.put("assignable_to", patch.assignableTo());
        JsonNode raw = http.request(HttpTransport.Request.of(
                "PATCH", "/platforms/" + enc(realmId) + "/roles/" + enc(roleId)).body(b));
        return http.mapper().convertValue(raw, RoleObject.class);
    }

    /** DELETE /platforms/{id}/roles/{roleId}. */
    public RoleDeleteResult delete(String roleId) { return delete(roleId, null); }

    /**
     * DELETE /platforms/{id}/roles/{roleId}. Pass {@code migrateTo}
     * (ADR-074/Phase 3) to reassign every holder of this role to another role
     * server-side (one transaction) instead of getting a 409 {@code role_in_use}.
     */
    public RoleDeleteResult delete(String roleId, String migrateTo) {
        HttpTransport.Request req = HttpTransport.Request.of(
                "DELETE", "/platforms/" + enc(realmId) + "/roles/" + enc(roleId));
        if (migrateTo != null && !migrateTo.isEmpty()) {
            Map<String, Object> q = new LinkedHashMap<>();
            q.put("migrate_to", migrateTo);
            req = req.query(q);
        }
        JsonNode raw = http.request(req);
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

    /**
     * POST /platforms/{id}/roles/{roleId}/disable. Soft-disables the role;
     * it stays in the catalog but is hidden and no longer assignable. The
     * server rejects disabling a protected role ({@code owner}/{@code
     * platform_api}), the realm's current default invitation role, or the
     * last remaining active role.
     */
    public RoleObject disable(String roleId) {
        return setDisabled(roleId, true);
    }

    /** POST /platforms/{id}/roles/{roleId}/enable — re-enable a disabled role. */
    public RoleObject enable(String roleId) {
        return setDisabled(roleId, false);
    }

    private RoleObject setDisabled(String roleId, boolean disabled) {
        String action = disabled ? "disable" : "enable";
        JsonNode raw = http.request(HttpTransport.Request.of(
                "POST", "/platforms/" + enc(realmId) + "/roles/" + enc(roleId) + "/" + action));
        return http.mapper().convertValue(raw, RoleObject.class);
    }

    /**
     * GET /platforms/{id}/permissions — the fixed catalog of grantable
     * permissions (ADR-074). Served live (not a static constant) so callers
     * can't drift from the server's catalog.
     */
    public List<Permission> listPermissions() {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "GET", "/platforms/" + enc(realmId) + "/permissions"));
        List<Permission> out = new ArrayList<>();
        if (raw != null && raw.has("permissions") && raw.get("permissions").isArray()) {
            for (JsonNode n : raw.get("permissions")) out.add(http.mapper().convertValue(n, Permission.class));
        }
        return out;
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
