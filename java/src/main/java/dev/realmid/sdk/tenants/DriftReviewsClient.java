package dev.realmid.sdk.tenants;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.http.HttpTransport;
import dev.realmid.sdk.pagination.PageReader;
import dev.realmid.sdk.pagination.Paginated;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/** SPEC §6.8 — contact-drift review queue. */
public final class DriftReviewsClient {
    private final HttpTransport http;

    public DriftReviewsClient(HttpTransport http) { this.http = http; }

    public Paginated<DriftReview> list(String tenantId) { return list(tenantId, null); }

    public Paginated<DriftReview> list(String tenantId, DriftReviewListOpts opts) {
        String userId = opts == null ? null : opts.userId();
        return Paginated.of(pageOpts -> {
            Map<String, Object> q = new LinkedHashMap<>();
            if (userId != null) q.put("user_id", userId);
            if (pageOpts.cursor() != null) q.put("cursor", pageOpts.cursor());
            if (pageOpts.limit() != null) q.put("limit", pageOpts.limit());
            JsonNode raw = http.request(HttpTransport.Request.of(
                    "GET", "/tenants/" + enc(tenantId) + "/contact-drift-reviews").query(q));
            return PageReader.read(http.mapper(), raw, DriftReview.class);
        });
    }

    public DriftAcceptResult accept(String tenantId, String reviewId) {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "POST", "/tenants/" + enc(tenantId) + "/contact-drift-reviews/" + enc(reviewId) + "/accept"));
        return http.mapper().convertValue(raw, DriftAcceptResult.class);
    }

    public DriftRejectResult reject(String tenantId, String reviewId) {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "POST", "/tenants/" + enc(tenantId) + "/contact-drift-reviews/" + enc(reviewId) + "/reject"));
        return http.mapper().convertValue(raw, DriftRejectResult.class);
    }

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }
}
