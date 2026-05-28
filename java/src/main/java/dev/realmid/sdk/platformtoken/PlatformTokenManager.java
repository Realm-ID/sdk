package dev.realmid.sdk.platformtoken;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.Logging;
import dev.realmid.sdk.RealmException;

import java.io.IOException;
import java.lang.System.Logger;
import java.lang.System.Logger.Level;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Two-endpoint platform-session machinery (SPEC §4.0, ADR-051). Holds a
 * short-lived platform access token for the SDK's own identity, minted from
 * the realm's API key. Re-mints automatically when fewer than
 * {@code refreshSkew} remain on its lifetime. Thread-safe.
 *
 * <p>Lifecycle (the raw API key only ever travels on the first call):
 * <ol>
 *   <li>First call: {@code POST /auth/login {grant_type:"platform_api_key",
 *       api_key}} → {@code {refresh_token, access_token, expires_in}}.</li>
 *   <li>Within the pre-expiry skew window: {@code POST /auth/token} with the
 *       refresh token as the {@code Authorization} bearer → the same shape.
 *       Whether the platform refresh rotates is realm-configurable
 *       ({@code platform_refresh_rotates}); either way the SDK stores whatever
 *       the server returns.</li>
 *   <li>If {@code /auth/token} 401s (refresh revoked or rotated by another
 *       caller), the SDK falls back to a fresh platform login transparently.</li>
 * </ol>
 *
 * <p>Replaces the pre-v0.10 {@code POST /auth/platform-token} bootstrap, which
 * the server hard-cut in v0.7.0 (ADR-051).
 */
public final class PlatformTokenManager {

    private static final Duration DEFAULT_REFRESH_SKEW = Duration.ofSeconds(30);

    private final String apiKey;
    private final String baseUrl;
    private final HttpClient http;
    private final ObjectMapper mapper;
    private final Logger logger;
    private final Clock clock;
    private final Duration refreshSkew;

    private String cachedRefreshToken;
    private String cachedToken;
    private long cachedExpiresAtMs;

    public PlatformTokenManager(String apiKey, String baseUrl, HttpClient http,
                                ObjectMapper mapper, Logger logger, Clock clock,
                                Duration refreshSkew) {
        this.apiKey = apiKey;
        this.baseUrl = stripSlash(baseUrl);
        this.http = http;
        this.mapper = mapper;
        this.logger = logger == null ? Logging.NOOP : logger;
        this.clock = clock == null ? Clock.systemUTC() : clock;
        this.refreshSkew = refreshSkew == null ? DEFAULT_REFRESH_SKEW : refreshSkew;
    }

    /**
     * Clears the cached access token, forcing a re-acquire on the next call.
     * The refresh token is preserved so the next {@link #getToken()} can try
     * {@code /auth/token} before a full re-login.
     */
    public synchronized void invalidate() {
        cachedToken = null;
        cachedExpiresAtMs = 0L;
    }

    /** Returns a fresh-enough platform token, acquiring one if needed. */
    public synchronized String getToken() {
        long now = clock.millis();
        if (cachedToken != null && cachedExpiresAtMs - now > refreshSkew.toMillis()) {
            return cachedToken;
        }
        acquire();
        return cachedToken;
    }

    /**
     * Acquires an access token: refresh via {@code /auth/token} if we hold a
     * refresh token, falling back to a full {@code /auth/login} on a 401 (or
     * when no refresh token is held yet).
     */
    private void acquire() {
        if (cachedRefreshToken != null && !cachedRefreshToken.isEmpty()) {
            try {
                refreshAccess(cachedRefreshToken);
                return;
            } catch (RealmException e) {
                // 401 on /auth/token → refresh revoked or rotated; fall back to
                // a full login. Other errors (network, 5xx) bubble up.
                if (e.getHttpStatus() != 401 && e.getCode() != ErrorCode.UNAUTHORIZED) {
                    throw e;
                }
                if (logger.isLoggable(Level.INFO)) {
                    logger.log(Level.INFO, "realmid session: refresh rejected, re-logging in");
                }
            }
        }
        login();
    }

    /** Exchanges the raw API key for a refresh + access token. */
    private void login() {
        if (apiKey == null || apiKey.isEmpty()) {
            throw new RealmException(ErrorCode.UNAUTHORIZED,
                    "no API key configured for platform login");
        }
        if (logger.isLoggable(Level.INFO)) {
            logger.log(Level.INFO, "realmid: platform login apiKey={0}", Logging.redact(apiKey));
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("grant_type", "platform_api_key");
        body.put("api_key", apiKey);
        JsonNode resp = send("/auth/login", null, body, "platform login");
        store(resp, null, "platform login");
    }

    /**
     * Mints a new access token (possibly rotating the refresh token) via
     * {@code POST /auth/token}, presenting the refresh token as the bearer.
     */
    private void refreshAccess(String refresh) {
        if (logger.isLoggable(Level.DEBUG)) {
            logger.log(Level.DEBUG, "realmid session: refreshing platform access");
        }
        JsonNode resp = send("/auth/token", refresh, new LinkedHashMap<>(), "/auth/token");
        store(resp, refresh, "/auth/token");
    }

    private JsonNode send(String path, String bearer, Map<String, Object> body, String what) {
        byte[] payload;
        try {
            payload = mapper.writeValueAsBytes(body);
        } catch (Exception e) {
            throw new RealmException(ErrorCode.BAD_REQUEST, "could not serialize " + what + " body", e);
        }
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(baseUrl + path))
                .timeout(Duration.ofSeconds(10))
                .header("accept", "application/json")
                .header("content-type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofByteArray(payload));
        if (bearer != null && !bearer.isEmpty()) {
            b.header("authorization", "Bearer " + bearer);
        }

        HttpResponse<byte[]> resp;
        try {
            resp = sendWithRetry(b.build());
        } catch (IOException e) {
            if (logger.isLoggable(Level.ERROR)) {
                logger.log(Level.ERROR, "realmid: {0} network error message={1}", what, e.getMessage());
            }
            throw new RealmException(ErrorCode.NETWORK,
                    "network error on " + what + ": " + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RealmException(ErrorCode.NETWORK, "interrupted on " + what, e);
        }

        int status = resp.statusCode();
        JsonNode parsed = null;
        if (resp.body() != null && resp.body().length > 0) {
            try {
                parsed = mapper.readTree(resp.body());
            } catch (IOException ignored) { /* non-JSON */ }
        }

        if (status < 200 || status >= 300) {
            ErrorCode code = (status == 401 || status == 403)
                    ? ErrorCode.UNAUTHORIZED
                    : (status >= 500 ? ErrorCode.SERVER_ERROR : ErrorCode.BAD_REQUEST);
            String msg = what + " failed with HTTP " + status;
            if (parsed != null && parsed.isObject()) {
                JsonNode env = parsed.get("error");
                JsonNode mNode = env != null && env.isObject() ? env.get("message") : parsed.get("message");
                if (mNode != null && mNode.isTextual() && !mNode.asText().isEmpty()) msg = mNode.asText();
            }
            if (logger.isLoggable(Level.ERROR)) {
                logger.log(Level.ERROR, "realmid: {0} failed status={1}", what, status);
            }
            throw new RealmException(code, msg, status, null);
        }
        if (parsed == null || !parsed.isObject()) {
            throw new RealmException(ErrorCode.SERVER_ERROR, what + " response was not JSON");
        }
        return parsed;
    }

    /**
     * Send with one retry on EOF — the same JDK HttpClient keep-alive quirk
     * {@code HttpTransport} guards against: a pooled socket closed by the
     * server between requests surfaces as "no bytes" on the next send. Auth
     * mint/refresh is idempotent enough for one retry.
     */
    private HttpResponse<byte[]> sendWithRetry(HttpRequest req) throws IOException, InterruptedException {
        IOException last = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            try {
                return http.send(req, HttpResponse.BodyHandlers.ofByteArray());
            } catch (IOException e) {
                if (!isRetriableEof(e)) throw e;
                last = e;
            }
        }
        throw last;
    }

    private static boolean isRetriableEof(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof java.io.EOFException) return true;
            String msg = t.getMessage();
            if (msg != null && (msg.contains("header parser received no bytes")
                    || msg.contains("EOF reached")
                    || msg.contains("Connection reset")
                    || msg.contains("GOAWAY"))) {
                return true;
            }
        }
        return false;
    }

    private void store(JsonNode resp, String presentedRefresh, String what) {
        JsonNode tok = resp.get("access_token");
        if (tok == null || !tok.isTextual() || tok.asText().isEmpty()) {
            throw new RealmException(ErrorCode.SERVER_ERROR, what + " returned empty access token");
        }
        JsonNode rt = resp.get("refresh_token");
        String refresh = (rt != null && rt.isTextual() && !rt.asText().isEmpty())
                ? rt.asText()
                : presentedRefresh; // non-rotating realm: keep the one we sent
        JsonNode exp = resp.get("expires_in");
        long ttlMs = (exp != null && exp.isNumber() && exp.asLong() > 0)
                ? exp.asLong() * 1000L
                : Duration.ofMinutes(5).toMillis(); // SPEC §4.0 default

        cachedToken = tok.asText();
        if (refresh != null && !refresh.isEmpty()) cachedRefreshToken = refresh;
        cachedExpiresAtMs = clock.millis() + ttlMs;

        if (logger.isLoggable(Level.INFO)) {
            logger.log(Level.INFO, "realmid: platform session ready via {0} token={1} ttlMs={2}",
                    what, Logging.redact(cachedToken), ttlMs);
        }
    }

    private static String stripSlash(String s) {
        int end = s.length();
        while (end > 0 && s.charAt(end - 1) == '/') end--;
        return s.substring(0, end);
    }
}
