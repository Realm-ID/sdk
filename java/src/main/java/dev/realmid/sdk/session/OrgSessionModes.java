package dev.realmid.sdk.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.Logging;

import java.lang.System.Logger;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.ConcurrentHashMap;

/**
 * SPEC §6.7.3 — a realm's org-session mode, read from its discovery document
 * ({@code GET {baseUrl}/{realm}/.well-known/openid-configuration}), field
 * {@value #FIELD}. {@code "exclusive"} or {@code "concurrent"}; an absent field,
 * {@code ""}, an unknown value or a failed fetch all mean {@code concurrent}
 * (fail-soft = refuse FEWER tokens). Cached per realm for 10 minutes, a failure
 * included, so a failed fetch retries at the next expiry and warns once.
 * Never fetched by {@code verify()}.
 */
public final class OrgSessionModes {

    /** The discovery field (ADR-109 D10.3). Not the SDK's browser-body {@code org_session_mode}. */
    public static final String FIELD = "realmid_org_sessions";
    public static final String CONCURRENT = "concurrent";
    public static final String EXCLUSIVE = "exclusive";
    static final Duration TTL = Duration.ofMinutes(10);

    private record Cached(String mode, Instant fetchedAt) {}

    private final String baseUrl;
    private final String defaultRealmId;
    private final HttpClient http;
    private final ObjectMapper mapper;
    private final Clock clock;
    private final Logger logger;
    private final ConcurrentHashMap<String, Cached> cache = new ConcurrentHashMap<>();

    public OrgSessionModes(String baseUrl, String defaultRealmId, HttpClient http, ObjectMapper mapper,
                           Clock clock, Logger logger) {
        this.baseUrl = stripSlash(baseUrl);
        this.defaultRealmId = defaultRealmId;
        this.http = http == null ? HttpClient.newHttpClient() : http;
        this.mapper = mapper == null ? new ObjectMapper() : mapper;
        this.clock = clock == null ? Clock.systemUTC() : clock;
        this.logger = logger == null ? Logging.NOOP : logger;
    }

    /** The mode for the realm {@code iss} names (its last path segment, as the verifier resolves JWKS). */
    public String mode(String iss) {
        String realm = realmOf(iss);
        Instant now = Instant.now(clock);
        Cached c = cache.get(realm);
        if (c != null && c.fetchedAt().plus(TTL).isAfter(now)) return c.mode();
        String mode = fetch(realm);
        cache.put(realm, new Cached(mode, now));
        return mode;
    }

    private String realmOf(String iss) {
        if (iss != null) {
            int i = iss.lastIndexOf('/');
            if (i >= 0 && i < iss.length() - 1) return iss.substring(i + 1);
        }
        return defaultRealmId;
    }

    private String fetch(String realm) {
        try {
            HttpRequest req = HttpRequest.newBuilder(
                            URI.create(baseUrl + "/" + realm + "/.well-known/openid-configuration"))
                    .timeout(Duration.ofSeconds(5)).GET().build();
            HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() != 200) throw new IllegalStateException("status " + resp.statusCode());
            JsonNode f = mapper.readTree(resp.body()).get(FIELD);
            return f != null && f.isTextual() && EXCLUSIVE.equals(f.asText()) ? EXCLUSIVE : CONCURRENT;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            warn(realm, e);
            return CONCURRENT;
        } catch (Exception e) {
            warn(realm, e);
            return CONCURRENT;
        }
    }

    private void warn(String realm, Exception e) {
        if (logger.isLoggable(Logger.Level.WARNING)) {
            logger.log(Logger.Level.WARNING,
                    "realmid: org-session mode discovery failed realm={0} reason={1}; treating as concurrent",
                    realm, e.getMessage());
        }
    }

    private static String stripSlash(String s) {
        int end = s.length();
        while (end > 0 && s.charAt(end - 1) == '/') end--;
        return s.substring(0, end);
    }
}
