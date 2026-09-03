package dev.realmid.sdk.apikeys;

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

/** SPEC §6.5. */
public final class APIKeysClient {

    private final HttpTransport http;
    private final String realmId;

    public APIKeysClient(HttpTransport http, String realmId) {
        this.http = http;
        this.realmId = realmId;
    }

    public APIKey create(APIKeyCreate body) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("scope", body.scope());
        if (body.label() != null) b.put("label", body.label());
        JsonNode raw = http.request(HttpTransport.Request.of(
                "POST", "/platforms/" + enc(realmId) + "/api-keys").body(b));
        return http.mapper().convertValue(raw, APIKey.class);
    }

    /**
     * Paginates this realm's API keys.
     *
     * <p>Returns the PAGER, not a {@code List}. The previous signature answered
     * a bare list from a paginated {@code {items, next_cursor, total}}
     * envelope, so a caller could neither page nor detect truncation.
     */
    public Paginated<APIKey> list() {
        String path = "/platforms/" + enc(realmId) + "/api-keys";
        return Paginated.of(opts -> {
            Map<String, Object> q = new LinkedHashMap<>();
            if (opts.cursor() != null) q.put("cursor", opts.cursor());
            if (opts.limit() != null) q.put("limit", opts.limit());
            JsonNode raw = http.request(HttpTransport.Request.of("GET", path).query(q));
            return PageReader.read(http.mapper(), raw, APIKey.class);
        });
    }

    public void revoke(String id) {
        http.request(HttpTransport.Request.of(
                "DELETE", "/platforms/" + enc(realmId) + "/api-keys/" + enc(id)));
    }

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }
}
