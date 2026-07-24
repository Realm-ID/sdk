package dev.realmid.sdk.tenants;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.http.HttpTransport;
import dev.realmid.sdk.pagination.PageReader;
import dev.realmid.sdk.pagination.Paginated;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/** SPEC §6.1. */
public final class TenantsClient {
    private final HttpTransport http;
    private final String realmId;
    private final InvitationsClient invitations;
    private final UsersClient users;
    private final DriftReviewsClient driftReviews;
    private final ContactVerificationsClient contactVerifications;

    public TenantsClient(HttpTransport http, String realmId) {
        this.http = http;
        this.realmId = realmId;
        this.invitations = new InvitationsClient(http);
        this.users = new UsersClient(http);
        this.driftReviews = new DriftReviewsClient(http);
        this.contactVerifications = new ContactVerificationsClient(http);
    }

    public InvitationsClient invitations() { return invitations; }
    public UsersClient users() { return users; }
    public DriftReviewsClient driftReviews() { return driftReviews; }
    public ContactVerificationsClient contactVerifications() { return contactVerifications; }

    public Paginated<Tenant> list() {
        return Paginated.of(opts -> {
            Map<String, Object> q = new LinkedHashMap<>();
            if (opts.cursor() != null) q.put("cursor", opts.cursor());
            if (opts.limit() != null) q.put("limit", opts.limit());
            JsonNode raw = http.request(HttpTransport.Request.of("GET", "/tenants").query(q));
            return PageReader.read(http.mapper(), raw, Tenant.class);
        });
    }

    public Tenant get(String id) {
        JsonNode raw = http.request(HttpTransport.Request.of("GET", "/tenants/" + enc(id)));
        return http.mapper().convertValue(raw, Tenant.class);
    }

    /**
     * Create a tenant under the calling platform (SPEC §6.1). The realm is
     * implicit (the API key's realm), so this routes to
     * {@code POST /platforms/{realmId}/tenants}.
     */
    public Tenant create(TenantCreate body) {
        Map<String, Object> b = new LinkedHashMap<>();
        if (body.id() != null) b.put("id", body.id());
        b.put("display_name", body.displayName());
        if (body.allowedDomains() != null) b.put("allowed_domains", body.allowedDomains());
        if (body.signupMode() != null) b.put("signup_mode", body.signupMode());
        if (body.createdAt() != null) b.put("created_at", body.createdAt());
        if (body.owner() != null) b.put("owner", ownerWire(body.owner()));
        JsonNode raw = http.request(HttpTransport.Request.of(
                "POST", "/platforms/" + enc(realmId) + "/tenants").body(b));
        return http.mapper().convertValue(raw, Tenant.class);
    }

    private static Map<String, Object> ownerWire(TenantOwner o) {
        Map<String, Object> m = new LinkedHashMap<>();
        if (o.userId() != null) m.put("user_id", o.userId());
        if (o.email() != null) m.put("email", o.email());
        if (o.phone() != null) m.put("phone", o.phone());
        if (o.displayName() != null) m.put("display_name", o.displayName());
        if (o.provider() != null) m.put("provider", o.provider());
        if (o.providerUid() != null) m.put("provider_uid", o.providerUid());
        return m;
    }

    public Tenant update(String id, TenantPatch patch) {
        Map<String, Object> b = new LinkedHashMap<>();
        if (patch.displayName() != null) b.put("display_name", patch.displayName());
        JsonNode raw = http.request(HttpTransport.Request.of("PATCH", "/tenants/" + enc(id)).body(b));
        return http.mapper().convertValue(raw, Tenant.class);
    }

    public Tenant updateConfig(String id, Map<String, Object> patch) {
        JsonNode raw = http.request(HttpTransport.Request.of("PATCH", "/tenants/" + enc(id) + "/config").body(patch));
        return http.mapper().convertValue(raw, Tenant.class);
    }

    public void delete(String id) {
        http.request(HttpTransport.Request.of("DELETE", "/tenants/" + enc(id)));
    }

    /** Plain ownership hand-over (ADR-076). Outgoing owner demoted to the server default. */
    public Tenant transferOwner(String id, String newOwnerUserId) {
        return transferOwner(id, newOwnerUserId, null);
    }

    /**
     * Reassign tenant ownership to {@code newOwnerUserId} — the ADR-076 direct
     * owner-pointer op (PUT /tenants/{id}/owner). The recipient must be an
     * active member of the tenant. {@code opts} is optional (pass {@code null}
     * for a plain hand-over): set {@code outgoingOwnerRole} / {@code
     * leaveEntirely} to control the outgoing owner's fate.
     */
    public Tenant transferOwner(String id, String newOwnerUserId, TransferOwnerOptions opts) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("owner_user_id", newOwnerUserId);
        if (opts != null) {
            if (opts.outgoingOwnerRole() != null) b.put("outgoing_owner_role", opts.outgoingOwnerRole());
            if (opts.leaveEntirely() != null) b.put("leave_entirely", opts.leaveEntirely());
        }
        JsonNode raw = http.request(HttpTransport.Request.of("PUT", "/tenants/" + enc(id) + "/owner").body(b));
        return http.mapper().convertValue(raw, Tenant.class);
    }

    /**
     * Set a user's role within a tenant (PATCH /tenants/{id}/users/{uid}/role).
     * The role name must exist in the realm's role catalog. Setting
     * {@code role=owner} is rejected — use {@link #transferOwner} for the
     * explicit handover. Demoting the last owner returns
     * {@code RealmException(last_owner)}.
     */
    public UpdateUserRoleResult updateUserRole(String tenantId, String userId, String role) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("role", role);
        JsonNode raw = http.request(HttpTransport.Request.of(
                "PATCH", "/tenants/" + enc(tenantId) + "/users/" + enc(userId) + "/role").body(b));
        return http.mapper().convertValue(raw, UpdateUserRoleResult.class);
    }

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }
}
