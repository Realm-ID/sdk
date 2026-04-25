package dev.realmid.sdk;

import java.net.http.HttpClient;
import java.time.Clock;
import java.time.Duration;
import java.util.Objects;

/**
 * Configuration for {@link Verifier}. Build via {@link #builder()}.
 *
 * <p>{@code baseUrl} and {@code audience} are required. Other fields fall
 * back to sensible defaults: 5s HTTP timeout, 10m JWKS cache, 30s clock
 * skew leeway, system clock.</p>
 */
public final class Config {
    private final String baseUrl;
    private final String audience;
    private final HttpClient httpClient;
    private final Duration cacheTtl;
    private final Duration leeway;
    private final Clock clock;

    private Config(Builder b) {
        if (b.baseUrl == null || b.baseUrl.isEmpty()) {
            throw new IllegalArgumentException("realmid: baseUrl required");
        }
        if (b.audience == null || b.audience.isEmpty()) {
            throw new IllegalArgumentException("realmid: audience required");
        }
        this.baseUrl = stripTrailingSlash(b.baseUrl);
        this.audience = b.audience;
        this.httpClient = b.httpClient != null
                ? b.httpClient
                : HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
        this.cacheTtl = b.cacheTtl != null ? b.cacheTtl : Duration.ofMinutes(10);
        this.leeway = b.leeway != null ? b.leeway : Duration.ofSeconds(30);
        this.clock = b.clock != null ? b.clock : Clock.systemUTC();
    }

    public String baseUrl() { return baseUrl; }
    public String audience() { return audience; }
    public HttpClient httpClient() { return httpClient; }
    public Duration cacheTtl() { return cacheTtl; }
    public Duration leeway() { return leeway; }
    public Clock clock() { return clock; }

    public static Builder builder() {
        return new Builder();
    }

    private static String stripTrailingSlash(String s) {
        int end = s.length();
        while (end > 0 && s.charAt(end - 1) == '/') {
            end--;
        }
        return s.substring(0, end);
    }

    public static final class Builder {
        private String baseUrl;
        private String audience;
        private HttpClient httpClient;
        private Duration cacheTtl;
        private Duration leeway;
        private Clock clock;

        public Builder baseUrl(String v) { this.baseUrl = Objects.requireNonNull(v); return this; }
        public Builder audience(String v) { this.audience = Objects.requireNonNull(v); return this; }
        public Builder httpClient(HttpClient v) { this.httpClient = v; return this; }
        public Builder cacheTtl(Duration v) { this.cacheTtl = v; return this; }
        public Builder leeway(Duration v) { this.leeway = v; return this; }
        public Builder clock(Clock v) { this.clock = v; return this; }

        public Config build() {
            return new Config(this);
        }
    }
}
