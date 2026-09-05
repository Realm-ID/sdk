package dev.realmid.sdk.roles;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.http.HttpTransport;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * RealmID's role VOCABULARY — ADR-101 D1's write side.
 *
 * <p>Distinct from {@link RolesClient}, and the distinction is the whole ADR. A
 * ROLE belongs to one realm and has holders; a TEMPLATE is the recipe a role is
 * stamped from, and it belongs to RealmID. Partners cannot reach this surface:
 * every route is base-realm-gated (D4) and answers
 * {@code role_authoring_retired} anywhere else, whose remedy is ADR-097 opaque
 * scopes rather than a retry. It is in the SDK because RealmID's own console is
 * an SDK consumer like any other.
 *
 * <p>D1 moved the vocabulary out of compiled-in constants and into a table so
 * that adding a role stops requiring a release. The table landed first and was
 * read-only, which made that true of the schema and not of the workflow — these
 * methods are the workflow.
 */
public final class RoleTemplatesClient {

    private final HttpTransport http;
    private final String realmId;

    public RoleTemplatesClient(HttpTransport http, String realmId) {
        this.http = http;
        this.realmId = realmId;
    }

    private String base() { return "/platforms/" + enc(realmId) + "/role-templates"; }

    /**
     * GET the vocabulary. A null {@code level} returns both levels.
     *
     * <p>Never returns null: an absent or JSON-null list becomes an empty list,
     * because the server's columns are NOT NULL and an iterating caller should
     * not have to defend against a shape that cannot legitimately occur.
     */
    public List<RoleTemplate> list(String level) {
        Map<String, Object> q = new LinkedHashMap<>();
        if (level != null && !level.isEmpty()) q.put("level", level);
        JsonNode raw = http.request(HttpTransport.Request.of("GET", base()).query(q));
        List<RoleTemplate> out = new ArrayList<>();
        if (raw == null) return out;
        JsonNode arr = raw.get("role_templates");
        if (arr == null || !arr.isArray()) return out;
        for (JsonNode n : arr) out.add(http.mapper().convertValue(n, RoleTemplate.class));
        return out;
    }

    /** GET the vocabulary at both levels. */
    public List<RoleTemplate> list() { return list(null); }

    /**
     * Add a role to RealmID's vocabulary.
     *
     * <p>A non-optional (floor) template FANS OUT to every realm governed at its
     * level. Read {@link RoleTemplateCreated#realmsStamped()}: it is what
     * distinguishes "the role exists for future realms" from "the role reached
     * the realms that already exist".
     */
    public RoleTemplateCreated create(RoleTemplateCreate body) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("level", body.level());
        b.put("name", body.name());
        // Always sent, never conditional: it is required server-side, and a body
        // that silently drops it is a 400 the caller cannot diagnose.
        b.put("assignable_to", body.assignableTo());
        if (body.displayName() != null) b.put("display_name", body.displayName());
        if (body.permissions() != null) b.put("permissions", body.permissions());
        if (body.system() != null) b.put("is_system", body.system());
        if (body.optional() != null) b.put("optional", body.optional());
        JsonNode raw = http.request(HttpTransport.Request.of("POST", base()).body(b));
        return http.mapper().convertValue(raw, RoleTemplateCreated.class);
    }

    /**
     * Patch a template's mutable fields.
     *
     * <p>Changes the RECIPE only — realms already holding a role stamped from
     * this template keep what they were stamped with. Read
     * {@link RoleTemplatePatched#driftedRealms()}, and note that -1 there means
     * "could not count", not "none" (see
     * {@link RoleTemplatePatched#driftUnknown()}).
     *
     * <p>May throw a {@link dev.realmid.sdk.RealmException} carrying, via
     * {@code getDetails().get("server_code")} (the same fallback
     * {@code role_authoring_retired} uses — this family is not in the general
     * {@link dev.realmid.sdk.ErrorCode} union):
     * <ul>
     *   <li>{@code role_template_seated} (409) — principals are currently
     *       seated at this template; the write was refused. RECOVERABLE: retry
     *       with {@code ?override_seated=true} (audited).</li>
     *   <li>{@code role_template_seat_check_failed} (503) — the seat count
     *       could not be TAKEN at all ("could not tell" must not read as
     *       "none"). ⚠️ UNCONDITIONAL — {@code override_seated=true} does NOT
     *       rescue this one; there is no count to override, only an inability
     *       to compute one. Do not build a retry loop around it.</li>
     * </ul>
     */
    public RoleTemplatePatched update(String templateId, RoleTemplatePatch patch) {
        Map<String, Object> b = new LinkedHashMap<>();
        // A null field is OMITTED, not sent as null: absent preserves the stored
        // value, whereas a null would be a decision the caller never made.
        if (patch.displayName() != null) b.put("display_name", patch.displayName());
        if (patch.permissions() != null) b.put("permissions", patch.permissions());
        if (patch.assignableTo() != null) b.put("assignable_to", patch.assignableTo());
        if (patch.system() != null) b.put("is_system", patch.system());
        if (patch.optional() != null) b.put("optional", patch.optional());
        JsonNode raw = http.request(HttpTransport.Request.of(
                "PATCH", base() + "/" + enc(templateId)).body(b));
        return http.mapper().convertValue(raw, RoleTemplatePatched.class);
    }

    /**
     * Remove a template from the vocabulary.
     *
     * <p>Roles already stamped from it KEEP their rows and their holders —
     * removing a role from a realm is a membership change, not a side effect of
     * tidying a vocabulary row.
     * {@link RoleTemplateDeleted#realmsStillHolding()} reports the orphans.
     *
     * <p>May throw the same two refusals documented on {@link
     * #update(String, RoleTemplatePatch)}: {@code role_template_seated} (409,
     * recoverable via {@code ?override_seated=true}) and {@code
     * role_template_seat_check_failed} (503, unconditional — no parameter
     * rescues it).
     */
    public RoleTemplateDeleted delete(String templateId) {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "DELETE", base() + "/" + enc(templateId)));
        return http.mapper().convertValue(raw, RoleTemplateDeleted.class);
    }

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }
}
