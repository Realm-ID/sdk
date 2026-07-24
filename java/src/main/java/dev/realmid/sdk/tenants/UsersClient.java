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

    public Paginated<User> list(String tenantId) { return list(tenantId, null); }

    /**
     * List users in a tenant (SPEC §6.3). {@code opts} may carry
     * {@code role}/{@code status}/{@code q} filters (S-07); null → unfiltered.
     */
    public Paginated<User> list(String tenantId, UserListOpts opts) {
        String role = opts == null ? null : opts.role();
        String status = opts == null ? null : opts.status();
        String q = opts == null ? null : opts.q();
        return Paginated.of(pageOpts -> {
            Map<String, Object> query = new LinkedHashMap<>();
            if (role != null) query.put("role", role);
            if (status != null) query.put("status", status);
            if (q != null) query.put("q", q);
            if (pageOpts.cursor() != null) query.put("cursor", pageOpts.cursor());
            if (pageOpts.limit() != null) query.put("limit", pageOpts.limit());
            JsonNode raw = http.request(HttpTransport.Request.of(
                    "GET", "/tenants/" + enc(tenantId) + "/users").query(query));
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
            if (r.createdAt() != null) m.put("created_at", r.createdAt());
            wire.add(m);
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("users", wire);
        JsonNode raw = http.request(HttpTransport.Request.of(
                "POST", "/tenants/" + enc(tenantId) + "/users/import").body(body));
        return http.mapper().convertValue(raw, ImportUsersResult.class);
    }

    /**
     * Delink a contact's provider binding (ADR-080 Part 2, POST
     * /tenants/{id}/users/{uid}/contacts/{contactId}/delink): every active
     * {@code contact_verifications} row bound to the contact is revoked, leaving
     * the {@code user_contacts} row ACTIVE but unmapped so a new provider
     * identity can bind on the next verified login (subject to the Phase A
     * verified-email gate). The explicit owner action that unblocks a
     * {@link dev.realmid.sdk.ErrorCode#CONTACT_ADMIN_REQUIRED} login — a
     * different provider claiming an address already bound to another identity —
     * without ever silently transferring the binding. Owner/admin only
     * ({@code users:manage}). Idempotent.
     */
    public DelinkContactResult delinkContact(String tenantId, String userId, String contactId) {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "POST", "/tenants/" + enc(tenantId) + "/users/" + enc(userId)
                        + "/contacts/" + enc(contactId) + "/delink"));
        return http.mapper().convertValue(raw, DelinkContactResult.class);
    }

    /**
     * Hand an account back (ADR-080 Part 3, POST
     * /tenants/{id}/users/{uid}/hand-back): the OLD account ({@code userId},
     * currently deactivated) is reactivated and the mistakenly-created NEW
     * account's ({@code fromUserId}) current email identity is moved onto it,
     * then the new account is disabled — the explicit, audited recovery for a
     * drift/rebind that created a separate account. The user's next verified
     * login rebinds the same provider UID to the old account. Owner/admin only
     * ({@code users:manage}). A missing {@code fromUserId} / same user /
     * source-with-no-email yields {@code RealmException(bad_request)}; a
     * deactivated-target requirement failure surfaces as
     * {@code RealmException(conflict)}.
     */
    public HandBackResult handBack(String tenantId, String userId, String fromUserId) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("from_user_id", fromUserId);
        JsonNode raw = http.request(HttpTransport.Request.of(
                "POST", "/tenants/" + enc(tenantId) + "/users/" + enc(userId) + "/hand-back").body(b));
        return http.mapper().convertValue(raw, HandBackResult.class);
    }

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }
}
