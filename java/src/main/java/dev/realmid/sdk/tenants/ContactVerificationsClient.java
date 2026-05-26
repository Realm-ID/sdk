package dev.realmid.sdk.tenants;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.http.HttpTransport;
import dev.realmid.sdk.pagination.PageReader;
import dev.realmid.sdk.pagination.Paginated;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/** SPEC §6.9 — first-login step-up contact-verification queue. */
public final class ContactVerificationsClient {
    private final HttpTransport http;

    public ContactVerificationsClient(HttpTransport http) { this.http = http; }

    public Paginated<ContactVerification> list(String tenantId) { return list(tenantId, null); }

    public Paginated<ContactVerification> list(String tenantId, ContactVerificationListOpts opts) {
        String state = opts == null ? null : opts.state();
        return Paginated.of(pageOpts -> {
            Map<String, Object> q = new LinkedHashMap<>();
            if (state != null) q.put("state", state);
            if (pageOpts.cursor() != null) q.put("cursor", pageOpts.cursor());
            if (pageOpts.limit() != null) q.put("limit", pageOpts.limit());
            JsonNode raw = http.request(HttpTransport.Request.of(
                    "GET", "/tenants/" + enc(tenantId) + "/contact-verifications").query(q));
            return PageReader.read(http.mapper(), raw, ContactVerification.class);
        });
    }

    public ContactVerificationResult approve(String tenantId, String verificationId) {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "POST", "/tenants/" + enc(tenantId) + "/contact-verifications/" + enc(verificationId) + "/approve"));
        return http.mapper().convertValue(raw, ContactVerificationResult.class);
    }

    public ContactVerificationResult reject(String tenantId, String verificationId) {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "POST", "/tenants/" + enc(tenantId) + "/contact-verifications/" + enc(verificationId) + "/reject"));
        return http.mapper().convertValue(raw, ContactVerificationResult.class);
    }

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }
}
