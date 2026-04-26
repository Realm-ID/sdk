package dev.realmid.sdk.apikeys;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.http.HttpTransport;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

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
        b.put("display_name", body.displayName());
        if (body.scopes() != null) b.put("scopes", body.scopes());
        JsonNode raw = http.request(HttpTransport.Request.of(
                "POST", "/realms/" + enc(realmId) + "/api-keys").body(b));
        return http.mapper().convertValue(raw, APIKey.class);
    }

    public List<APIKey> list() {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "GET", "/realms/" + enc(realmId) + "/api-keys"));
        if (raw == null) return List.of();
        if (raw.isArray()) {
            List<APIKey> out = new ArrayList<>(raw.size());
            for (JsonNode n : raw) out.add(http.mapper().convertValue(n, APIKey.class));
            return out;
        }
        JsonNode arr = raw.get("items");
        if (arr == null || !arr.isArray()) arr = raw.get("api_keys");
        if (arr == null || !arr.isArray()) return List.of();
        List<APIKey> out = new ArrayList<>(arr.size());
        for (JsonNode n : arr) out.add(http.mapper().convertValue(n, APIKey.class));
        return out;
    }

    public void revoke(String id) {
        http.request(HttpTransport.Request.of(
                "DELETE", "/realms/" + enc(realmId) + "/api-keys/" + enc(id)));
    }

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }
}
