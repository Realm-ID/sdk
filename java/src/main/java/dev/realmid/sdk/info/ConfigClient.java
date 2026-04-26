package dev.realmid.sdk.info;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.http.HttpTransport;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/** SPEC §6.5 config update. */
public final class ConfigClient {
    private final HttpTransport http;
    private final String realmId;

    public ConfigClient(HttpTransport http, String realmId) {
        this.http = http;
        this.realmId = realmId;
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> update(Map<String, Object> patch) {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "PATCH",
                "/realms/" + URLEncoder.encode(realmId, StandardCharsets.UTF_8) + "/config")
                .body(patch));
        return raw == null ? Map.of() : http.mapper().convertValue(raw, Map.class);
    }
}
