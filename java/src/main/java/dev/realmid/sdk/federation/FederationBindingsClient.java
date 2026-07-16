package dev.realmid.sdk.federation;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.http.HttpTransport;
import dev.realmid.sdk.pagination.PageReader;
import dev.realmid.sdk.pagination.Paginated;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Workload-identity federation trust bindings (ADR-057). CRUD over
 * {@code /platforms/{id}/federation-bindings}.
 */
public final class FederationBindingsClient {
    private final HttpTransport http;
    private final String realmId;

    public FederationBindingsClient(HttpTransport http, String realmId) {
        this.http = http;
        this.realmId = realmId;
    }

    private String base() {
        return "/platforms/" + enc(realmId) + "/federation-bindings";
    }

    /** Paginate the platform's federation bindings. */
    public Paginated<FederationBinding> list() {
        return Paginated.of(opts -> {
            Map<String, Object> q = new LinkedHashMap<>();
            if (opts.cursor() != null) q.put("cursor", opts.cursor());
            if (opts.limit() != null) q.put("limit", opts.limit());
            JsonNode raw = http.request(HttpTransport.Request.of("GET", base()).query(q));
            return PageReader.read(http.mapper(), raw, FederationBinding.class);
        });
    }

    /**
     * Register a federation binding. 409 {@code binding_exists} if an active
     * binding already has the same {@code (issuer, match_claims)} tuple.
     */
    public FederationBinding create(FederationBindingCreate body) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("issuer", body.issuer());
        b.put("match_claims", body.matchClaims());
        if (body.mappedRole() != null) b.put("mapped_role", body.mappedRole());
        if (body.scope() != null) b.put("scope", body.scope());
        JsonNode raw = http.request(HttpTransport.Request.of("POST", base()).body(b));
        return http.mapper().convertValue(raw, FederationBinding.class);
    }

    /** Revoke (soft-delete) a binding by id. A second call on a removed id 404s. */
    public FederationBindingRevokeResult revoke(String bindingId) {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "DELETE", base() + "/" + enc(bindingId)));
        return http.mapper().convertValue(raw, FederationBindingRevokeResult.class);
    }

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }
}
