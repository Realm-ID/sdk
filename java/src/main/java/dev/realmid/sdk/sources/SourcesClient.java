package dev.realmid.sdk.sources;

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

/**
 * Sources surface — {@code realm.sources()} (ADR-072). Mirrors Go's
 * {@code realm.Sources} / TS's {@code realm.sources}.
 *
 * <p>A source is a platform-level client app; its {@code allowed_methods} is
 * mapping-2 (the login methods that app surfaces). A {@code bot} source may
 * list only {@code otp}; a human source may never list {@code otp}
 * (mapping-1 invariant, ADR-072 §0).
 *
 * <p>Authorization is the realm's short-lived platform token (auto-attached by
 * the transport). Server error code {@code method_violates_kind} (400) surfaces
 * on {@link dev.realmid.sdk.RealmException}; a missing source surfaces as
 * {@code source_not_found} / {@code not_found}.
 */
public final class SourcesClient {

    private final HttpTransport http;
    private final String realmId;

    public SourcesClient(HttpTransport http, String realmId) {
        this.http = http;
        this.realmId = realmId;
    }

    /**
     * GET /sources?platform_id={realmId} — the realm's sources, disabled ones
     * included.
     *
     * <p>Returns the PAGER, not a {@code List}: the endpoint is paginated
     * server-side, so a list could only ever be page one with no way for the
     * caller to tell it was cut short. {@code stream()} walks every page;
     * {@code page(opts)} gives one page plus {@code hasMore}/{@code nextCursor}/
     * {@code total}.
     */
    public Paginated<Source> list() {
        return Paginated.of(opts -> {
            Map<String, Object> q = new LinkedHashMap<>();
            q.put("platform_id", realmId);
            if (opts.cursor() != null) q.put("cursor", opts.cursor());
            if (opts.limit() != null) q.put("limit", opts.limit());
            JsonNode raw = http.request(HttpTransport.Request.of("GET", "/sources").query(q));
            return PageReader.read(http.mapper(), raw, Source.class);
        });
    }

    /** POST /sources — register a new app/source. {@code platformId} defaults to the realm. */
    public Source create(SourceCreate body) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("platform_id", body.platformId() == null ? realmId : body.platformId());
        b.put("type", body.type());
        b.put("label", body.label());
        if (body.allowedMethods() != null) b.put("allowed_methods", body.allowedMethods());
        JsonNode raw = http.request(HttpTransport.Request.of("POST", "/sources").body(b));
        return http.mapper().convertValue(raw, Source.class);
    }

    /**
     * PATCH /sources/{id} — sparse update. {@code allowedMethods} is
     * re-validated against the source's type server-side.
     */
    public Source update(String id, SourcePatch patch) {
        Map<String, Object> b = new LinkedHashMap<>();
        if (patch.label() != null) b.put("label", patch.label());
        if (patch.allowedMethods() != null) b.put("allowed_methods", patch.allowedMethods());
        if (patch.enabled() != null) b.put("enabled", patch.enabled());
        JsonNode raw = http.request(HttpTransport.Request.of(
                "PATCH", "/sources/" + enc(id)).body(b));
        return http.mapper().convertValue(raw, Source.class);
    }

    /** DELETE /sources/{id}. */
    public void delete(String id) {
        http.request(HttpTransport.Request.of("DELETE", "/sources/" + enc(id)));
    }

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }
}
