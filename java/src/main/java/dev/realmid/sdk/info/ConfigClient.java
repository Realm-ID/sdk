package dev.realmid.sdk.info;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.http.HttpTransport;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/** SPEC §6.5 config read + update. */
public final class ConfigClient {
    private final HttpTransport http;
    private final String realmId;

    public ConfigClient(HttpTransport http, String realmId) {
        this.http = http;
        this.realmId = realmId;
    }

    /**
     * GET /platforms/{id}/config — the read counterpart of {@link #update}.
     *
     * <p>Authorization mirrors the PATCH exactly (the ADR-074
     * {@code platform:config} permission, or realm owner): anyone who may change
     * the config may read it. The returned {@code config} map is deliberately
     * untyped — see {@link RealmConfigResponse}.
     */
    public RealmConfigResponse get() {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "GET",
                "/platforms/" + URLEncoder.encode(realmId, StandardCharsets.UTF_8) + "/config"));
        if (raw == null) {
            return new RealmConfigResponse();
        }
        return http.mapper().convertValue(raw, RealmConfigResponse.class);
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> update(Map<String, Object> patch) {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "PATCH",
                "/platforms/" + URLEncoder.encode(realmId, StandardCharsets.UTF_8) + "/config")
                .body(patch));
        return raw == null ? Map.of() : http.mapper().convertValue(raw, Map.class);
    }
}
