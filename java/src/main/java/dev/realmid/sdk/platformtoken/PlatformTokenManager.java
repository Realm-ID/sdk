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
 * short-lived platform access token for the SDK's own identity, minted from a
 * bootstrap credential (a static API key or, per ADR-057, an ambient workload
 * OIDC token). Re-mints automatically when fewer than {@code refreshSkew}
 * remain on its lifetime. Thread-safe.
 *
 * <p>Lifecycle:
 * <ol>
 *   <li>{@code POST /auth/login} with the credential's grant
 *       ({@code platform_api_key} or {@code token-exchange}) →
 *       {@code {access_token, expires_in}}.</li>
 *   <li>Within the pre-expiry skew window: do exactly the same thing again.</li>
 * </ol>
 *
 * <p>There is no refresh step. ADR-089 (issuer v0.68.0) withdrew the refresh
 * token from every credential-bootstrapped session: the caller holds the
 * credential at the moment it needs a token, so a refresh token was a strictly
 * weaker duplicate of one it already had — and one that outlived revocation of
 * its source. Re-minting costs the same single round trip. The bootstrap
 * credential therefore travels on every acquisition (roughly once per
 * access-token lifetime), not just the first.
 *
 * <p>Note for anyone reviving a refresh path: {@code store} must never REQUIRE
 * {@code refresh_token}. Requiring it is what made the Go and TypeScript
 * clients fail hard rather than degrade when the issuer stopped sending it;
 * this implementation happened to treat it as optional and so survived.
 *
 * <p>Replaces the pre-v0.10 {@code POST /auth/platform-token} bootstrap, which
 * the server hard-cut in v0.7.0 (ADR-051).
 */
public final class PlatformTokenManager {

    private static final Duration DEFAULT_REFRESH_SKEW = Duration.ofSeconds(30);

    private final CredentialSource credential;
    private final String baseUrl;
    /** Realm this SDK was constructed for; null disables the ADR-041 pin. */
    private final String realmId;
    private final HttpClient http;
    private final ObjectMapper mapper;
    private final Logger logger;
    private final Clock clock;
    private final Duration refreshSkew;

    private String cachedToken;
    private long cachedExpiresAtMs;

    /**
     * Pre-realm-pin constructor. Kept for source compatibility; the ADR-041
     * realm pin is SKIPPED for a manager built this way, exactly as the TS
     * client skips it when no {@code realmId} is configured. Prefer the
     * overload that takes the realm id.
     */
    public PlatformTokenManager(CredentialSource credential, String baseUrl, HttpClient http,
                                ObjectMapper mapper, Logger logger, Clock clock,
                                Duration refreshSkew) {
        this(credential, baseUrl, http, mapper, logger, clock, refreshSkew, null);
    }

    public PlatformTokenManager(CredentialSource credential, String baseUrl, HttpClient http,
                                ObjectMapper mapper, Logger logger, Clock clock,
                                Duration refreshSkew, String realmId) {
        this.realmId = realmId == null || realmId.isEmpty() ? null : realmId;
        this.credential = credential;
        this.baseUrl = stripSlash(baseUrl);
        this.http = http;
        this.mapper = mapper;
        this.logger = logger == null ? Logging.NOOP : logger;
        this.clock = clock == null ? Clock.systemUTC() : clock;
        this.refreshSkew = refreshSkew == null ? DEFAULT_REFRESH_SKEW : refreshSkew;
    }

    /**
     * Clears the cached access token, forcing a re-mint from the bootstrap
     * credential on the next {@link #getToken()}. That is the only acquisition
     * path — ADR-089 withdrew the refresh token from this session class, so
     * there is nothing to preserve here and {@code /auth/token} is never
     * reached from this manager.
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

    /** Acquires an access token by minting one from the bootstrap credential. */
    private void acquire() {
        login();
    }

    /**
     * Exchanges the bootstrap credential (a static API key or an ambient
     * workload OIDC token) for an access token.
     */
    private void login() {
        Credential cred = credential.fetch();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("grant_type", cred.grantType());
        String redacted;
        if (Credential.GRANT_PLATFORM_API_KEY.equals(cred.grantType())) {
            if (cred.apiKey() == null || cred.apiKey().isEmpty()) {
                throw new RealmException(ErrorCode.UNAUTHORIZED, "credential source returned an empty API key");
            }
            body.put("api_key", cred.apiKey());
            redacted = Logging.redact(cred.apiKey());
        } else if (Credential.GRANT_TOKEN_EXCHANGE.equals(cred.grantType())) {
            if (cred.subjectToken() == null || cred.subjectToken().isEmpty()) {
                throw new RealmException(ErrorCode.UNAUTHORIZED, "credential source returned an empty workload token");
            }
            body.put("subject_token", cred.subjectToken());
            body.put("subject_token_type", Credential.SUBJECT_TOKEN_TYPE_JWT);
            redacted = Logging.redact(cred.subjectToken());
        } else {
            throw new RealmException(ErrorCode.BAD_REQUEST, "unsupported credential grant_type: " + cred.grantType());
        }
        if (logger.isLoggable(Level.INFO)) {
            logger.log(Level.INFO, "realmid: platform login grant_type={0} credential={1}",
                    new Object[] {cred.grantType(), redacted});
        }
        JsonNode resp = send("/auth/login", null, body, "platform login");
        JsonNode tok = resp.get("access_token");
        if (tok != null && tok.isTextual()) checkIssuer(tok.asText());
        store(resp, "platform login");
    }

    /**
     * ADR-041 client-side realm pin (SPEC §4.0). Decodes the just-minted
     * platform access token — no signature check, it arrived from RI over TLS
     * and verifying it is {@code Verifier}'s job — and confirms its {@code iss}
     * references the configured realm. Catches the confused-deputy case where
     * the SDK was built for realm A while the API key or workload credential
     * belongs to realm B, and raises it HERE rather than letting it surface as
     * a cryptic 4xx on some later management call.
     *
     * <p>A token whose payload cannot be decoded is NOT a mismatch: the pin
     * answers "whose realm is this token for", and an answer it cannot read is
     * left to the verifier. Mirrors Go's {@code checkIssuer} (returns nil on a
     * malformed payload) and TS's (peek returns "" → skip).
     */
    private void checkIssuer(String jwt) {
        if (realmId == null) return;
        String iss = peekJwtIssuer(jwt);
        if (iss == null || iss.isEmpty()) return;
        if (!iss.endsWith("/" + realmId)) {
            throw new RealmException(ErrorCode.REALM_MISMATCH,
                    "platform access token's iss does not match configured realm: got " + iss
                            + ", configured realm " + realmId);
        }
    }

    /** Returns the {@code iss} claim of a JWT payload, or "" when the token is
     *  not a decodable JWT. No signature verification. */
    private String peekJwtIssuer(String jwt) {
        String[] parts = jwt.split("\\.");
        if (parts.length != 3) return "";
        try {
            byte[] raw = java.util.Base64.getUrlDecoder().decode(parts[1]);
            JsonNode claims = mapper.readTree(raw);
            JsonNode iss = claims == null ? null : claims.get("iss");
            return iss != null && iss.isTextual() ? iss.asText() : "";
        } catch (RuntimeException | IOException e) {
            return "";
        }
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

    private void store(JsonNode resp, String what) {
        JsonNode tok = resp.get("access_token");
        if (tok == null || !tok.isTextual() || tok.asText().isEmpty()) {
            throw new RealmException(ErrorCode.SERVER_ERROR, what + " returned empty access token");
        }
        JsonNode exp = resp.get("expires_in");
        long ttlMs = (exp != null && exp.isNumber() && exp.asLong() > 0)
                ? exp.asLong() * 1000L
                : Duration.ofMinutes(5).toMillis(); // SPEC §4.0 default

        cachedToken = tok.asText();
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
