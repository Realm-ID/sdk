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

/**
 * Dual-token login machinery (SPEC §4.0). Holds a short-lived platform token
 * minted from the realm's API key. Re-mints automatically when fewer than
 * {@code refreshSkew} remain on its lifetime. Thread-safe.
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

    private volatile String cachedToken;
    private volatile long cachedExpiresAtMs;

    public PlatformTokenManager(String apiKey, String baseUrl, HttpClient http,
                                ObjectMapper mapper, Logger logger, Clock clock,
                                Duration refreshSkew) {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl;
        this.http = http;
        this.mapper = mapper;
        this.logger = logger == null ? Logging.NOOP : logger;
        this.clock = clock == null ? Clock.systemUTC() : clock;
        this.refreshSkew = refreshSkew == null ? DEFAULT_REFRESH_SKEW : refreshSkew;
    }

    public synchronized void invalidate() {
        cachedToken = null;
        cachedExpiresAtMs = 0L;
    }

    /** Returns a fresh-enough platform token, minting one if needed. */
    public synchronized String getToken() {
        long now = clock.millis();
        if (cachedToken != null && cachedExpiresAtMs - now > refreshSkew.toMillis()) {
            return cachedToken;
        }
        mint();
        return cachedToken;
    }

    private void mint() {
        URI uri = URI.create(stripSlash(baseUrl) + "/auth/platform-token");
        HttpRequest req = HttpRequest.newBuilder(uri)
                .timeout(Duration.ofSeconds(10))
                .header("authorization", "Bearer " + apiKey)
                .header("accept", "application/json")
                .header("content-type", "application/json")
                .POST(HttpRequest.BodyPublishers.noBody())
                .build();

        if (logger.isLoggable(Level.INFO)) {
            logger.log(Level.INFO, "realmid: minting platform token apiKey={0}", Logging.redact(apiKey));
        }

        HttpResponse<byte[]> resp;
        try {
            resp = http.send(req, HttpResponse.BodyHandlers.ofByteArray());
        } catch (IOException e) {
            if (logger.isLoggable(Level.ERROR)) {
                logger.log(Level.ERROR, "realmid: platform-token network error message={0}", e.getMessage());
            }
            throw new RealmException(ErrorCode.NETWORK,
                    "network error minting platform token: " + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RealmException(ErrorCode.NETWORK, "interrupted minting platform token", e);
        }

        int status = resp.statusCode();
        JsonNode body = null;
        if (resp.body() != null && resp.body().length > 0) {
            try {
                body = mapper.readTree(resp.body());
            } catch (IOException ignored) { /* non-JSON */ }
        }

        if (status < 200 || status >= 300) {
            ErrorCode code = (status == 401 || status == 403)
                    ? ErrorCode.UNAUTHORIZED
                    : (status >= 500 ? ErrorCode.SERVER_ERROR : ErrorCode.BAD_REQUEST);
            String msg = "platform-token mint failed with HTTP " + status;
            if (body != null && body.isObject()) {
                JsonNode env = body.get("error");
                if (env != null && env.isObject()) {
                    JsonNode m = env.get("message");
                    if (m != null && m.isTextual() && !m.asText().isEmpty()) msg = m.asText();
                }
            }
            if (logger.isLoggable(Level.ERROR)) {
                logger.log(Level.ERROR, "realmid: platform-token mint failed status={0}", status);
            }
            throw new RealmException(code, msg, status, null);
        }

        if (body == null || !body.isObject()) {
            throw new RealmException(ErrorCode.SERVER_ERROR, "platform-token response was not JSON");
        }
        JsonNode tok = body.get("platform_token");
        JsonNode exp = body.get("expires_in");
        if (tok == null || !tok.isTextual() || exp == null || !exp.isNumber()) {
            throw new RealmException(ErrorCode.SERVER_ERROR,
                    "platform-token response missing platform_token or expires_in");
        }
        cachedToken = tok.asText();
        cachedExpiresAtMs = clock.millis() + exp.asLong() * 1000L;
        if (logger.isLoggable(Level.INFO)) {
            logger.log(Level.INFO, "realmid: platform token minted token={0} expiresInSec={1}",
                    Logging.redact(cachedToken), exp.asLong());
        }
    }

    private static String stripSlash(String s) {
        int end = s.length();
        while (end > 0 && s.charAt(end - 1) == '/') end--;
        return s.substring(0, end);
    }
}
