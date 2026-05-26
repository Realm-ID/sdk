package dev.realmid.sdk.tenants;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.http.HttpTransport;
import dev.realmid.sdk.pagination.PageReader;
import dev.realmid.sdk.pagination.Paginated;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/** SPEC §6.2. */
public final class InvitationsClient {
    private final HttpTransport http;

    public InvitationsClient(HttpTransport http) { this.http = http; }

    public Paginated<Invitation> list(String tenantId) {
        return Paginated.of(opts -> {
            Map<String, Object> q = new LinkedHashMap<>();
            if (opts.cursor() != null) q.put("cursor", opts.cursor());
            if (opts.limit() != null) q.put("limit", opts.limit());
            JsonNode raw = http.request(HttpTransport.Request.of(
                    "GET", "/tenants/" + enc(tenantId) + "/invitations").query(q));
            return PageReader.read(http.mapper(), raw, Invitation.class);
        });
    }

    public Invitation create(String tenantId, InvitationCreate body) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("identifier", body.identifier());
        if (body.role() != null) b.put("role", body.role());
        JsonNode raw = http.request(HttpTransport.Request.of(
                "POST", "/tenants/" + enc(tenantId) + "/invitations").body(b));
        return http.mapper().convertValue(raw, Invitation.class);
    }

    public void delete(String tenantId, String invitationId) {
        http.request(HttpTransport.Request.of(
                "DELETE", "/tenants/" + enc(tenantId) + "/invitations/" + enc(invitationId)));
    }

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }
}
