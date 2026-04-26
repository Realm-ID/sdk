package dev.realmid.sdk.domains;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.http.HttpTransport;

import java.util.LinkedHashMap;
import java.util.Map;

/** SPEC §6.4. */
public final class DomainsClient {
    private final HttpTransport http;

    public DomainsClient(HttpTransport http) { this.http = http; }

    public DomainClaim claim(String hostname) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("hostname", hostname);
        JsonNode raw = http.request(HttpTransport.Request.of("POST", "/domains/claim").body(b));
        return http.mapper().convertValue(raw, DomainClaim.class);
    }

    public DomainVerifyResult verify(String claimToken) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("claim_token", claimToken);
        JsonNode raw = http.request(HttpTransport.Request.of("POST", "/domains/verify").body(b));
        return http.mapper().convertValue(raw, DomainVerifyResult.class);
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record DomainClaim(
            String hostname,
            @JsonProperty("claim_token") @JsonAlias("claimToken") String claimToken,
            @JsonProperty("txt_record") @JsonAlias("txtRecord") TxtRecord txtRecord,
            String status) {

        @JsonIgnoreProperties(ignoreUnknown = true)
        public record TxtRecord(String name, String value) {}
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record DomainVerifyResult(String hostname, Boolean verified, String status) {}
}
