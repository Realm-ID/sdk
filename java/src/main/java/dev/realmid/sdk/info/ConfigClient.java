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

    public Map<String, Object> update(Map<String, Object> patch) {
        return update(patch, false);
    }

    /**
     * As {@link #update(Map)}, with ADR-117 D8's {@code confirm_lockout}. {@code true} sends the
     * QUERY parameter {@code ?confirm_lockout=true} (never a header), which proceeds past
     * {@code 409 unique_kind_lockout} and is audited with the exact counts. It never escapes a
     * {@code 503 unique_kind_lockout_check_failed} or any other refusal. {@code false} sends no query.
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> update(Map<String, Object> patch, boolean confirmLockout) {
        HttpTransport.Request req = HttpTransport.Request.of(
                "PATCH",
                "/platforms/" + URLEncoder.encode(realmId, StandardCharsets.UTF_8) + "/config")
                .body(patch);
        if (confirmLockout) req.query(Map.of("confirm_lockout", "true"));
        JsonNode raw = http.request(req);
        return raw == null ? Map.of() : http.mapper().convertValue(raw, Map.class);
    }
}
