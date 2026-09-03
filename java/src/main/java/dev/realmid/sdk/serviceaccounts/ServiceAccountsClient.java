package dev.realmid.sdk.serviceaccounts;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.http.HttpTransport;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import dev.realmid.sdk.pagination.PageReader;
import dev.realmid.sdk.pagination.Paginated;
import dev.realmid.sdk.pagination.PageOpts;

/**
 * Service accounts surface — {@code realm.serviceAccounts()} (ADR-071 §2/§10).
 * Mirrors Go's {@code realm.ServiceAccounts} / TS's {@code realm.serviceAccounts}.
 *
 * <p>A service account is a first-class non-human identity ({@code kind=service})
 * that logs in via a {@code view_bff} OTP (never a human provider). This is the
 * owner/admin management surface over {@code /tenants/{id}/service-accounts}.
 *
 * <p>Authorization is the realm's short-lived platform token — exactly like the
 * {@code RolesClient}. The transport auto-attaches it; this client never handles
 * the API key. Server error codes surface on {@link dev.realmid.sdk.RealmException}
 * via {@link dev.realmid.sdk.ErrorCode}: {@code handle_taken} (409),
 * {@code invalid_role} (400), {@code service_account_not_found} /
 * {@code user_not_found} (404).
 */
public final class ServiceAccountsClient {

    private final HttpTransport http;

    public ServiceAccountsClient(HttpTransport http) {
        this.http = http;
    }

    private String base(String tenantId) {
        return "/tenants/" + enc(tenantId) + "/service-accounts";
    }

    /** POST /tenants/{id}/service-accounts — provision a service account. */
    public ServiceAccount create(String tenantId, ServiceAccountCreate body) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("handle", body.handle());
        if (body.role() != null) b.put("role", body.role());
        if (body.displayName() != null) b.put("display_name", body.displayName());
        JsonNode raw = http.request(HttpTransport.Request.of("POST", base(tenantId)).body(b));
        return http.mapper().convertValue(raw, ServiceAccount.class);
    }

    /**
     * GET /tenants/{id}/service-accounts — the tenant's service accounts.
     *
     * <p>Returns the PAGER, not a {@code List}: the endpoint is paginated
     * server-side, so a list would silently be page one. {@code stream()} walks
     * every page; {@code page(opts)} gives one page plus {@code hasMore}.
     */
    public Paginated<ServiceAccount> list(String tenantId) {
        return Paginated.of(opts -> {
            Map<String, Object> q = new LinkedHashMap<>();
            if (opts.cursor() != null) q.put("cursor", opts.cursor());
            if (opts.limit() != null) q.put("limit", opts.limit());
            JsonNode raw = http.request(HttpTransport.Request.of("GET", base(tenantId)).query(q));
            return PageReader.read(http.mapper(), raw, ServiceAccount.class);
        });
    }

    /** GET /tenants/{id}/service-accounts/{said}. */
    public ServiceAccount get(String tenantId, String id) {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "GET", base(tenantId) + "/" + enc(id)));
        return http.mapper().convertValue(raw, ServiceAccount.class);
    }

    /** POST …/{said}/reset-handle — change the login handle (unique-in-tenant). */
    public ServiceAccount resetHandle(String tenantId, String id, String handle) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("handle", handle);
        return action(tenantId, id, "reset-handle", b);
    }

    /** POST …/{said}/suspend — suspend and drop live sessions. */
    public ServiceAccount suspend(String tenantId, String id) {
        return action(tenantId, id, "suspend", null);
    }

    /** POST …/{said}/unsuspend — restore a suspended account. */
    public ServiceAccount unsuspend(String tenantId, String id) {
        return action(tenantId, id, "unsuspend", null);
    }

    /** POST …/{said}/deactivate — soft-delete (status=deactivated) + revoke sessions. */
    public ServiceAccount deactivate(String tenantId, String id) {
        return action(tenantId, id, "deactivate", null);
    }

    /**
     * POST …/{said}/revoke — drop all live sessions without changing status
     * (the account can log in again).
     */
    public ServiceAccountRevokeResult revoke(String tenantId, String id) {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "POST", base(tenantId) + "/" + enc(id) + "/revoke"));
        return http.mapper().convertValue(raw, ServiceAccountRevokeResult.class);
    }

    private ServiceAccount action(String tenantId, String id, String verb, Object body) {
        HttpTransport.Request r = HttpTransport.Request.of(
                "POST", base(tenantId) + "/" + enc(id) + "/" + verb);
        if (body != null) r.body(body);
        JsonNode raw = http.request(r);
        return http.mapper().convertValue(raw, ServiceAccount.class);
    }

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }
}
