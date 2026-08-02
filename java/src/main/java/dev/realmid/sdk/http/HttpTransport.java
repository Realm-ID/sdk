package dev.realmid.sdk.http;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.Logging;
import dev.realmid.sdk.RealmException;
import dev.realmid.sdk.platformtoken.PlatformTokenManager;

import java.io.IOException;
import java.lang.System.Logger;
import java.lang.System.Logger.Level;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Internal HTTP wrapper. Auto-attaches Authorization (api-key, platform-token,
 * or per-call user bearer), Content-Type, Origin (when supplied). Maps
 * non-2xx responses to {@link RealmException} (SPEC §3 + §8).
 */
public final class HttpTransport {

    private final String baseUrl;
    private final HttpClient client;
    private final ObjectMapper mapper;
    private final Logger logger;
    private final PlatformTokenManager tokens; // may be null
    private final String userToken; // may be null

    public HttpTransport(String baseUrl, HttpClient client, ObjectMapper mapper,
                         Logger logger, PlatformTokenManager tokens) {
        this(baseUrl, client, mapper, logger, tokens, null);
    }

    private HttpTransport(String baseUrl, HttpClient client, ObjectMapper mapper,
                          Logger logger, PlatformTokenManager tokens, String userToken) {
        this.baseUrl = stripTrailingSlash(baseUrl);
        this.client = client;
        this.mapper = mapper;
        this.logger = logger == null ? Logging.NOOP : logger;
        this.tokens = tokens;
        this.userToken = userToken;
    }

    /**
     * Returns a COPY of this transport that forwards {@code accessJWT} as
     * {@code X-User-Token} on every request (SPEC §4 verified on-behalf-of; ADR-056). The
     * platform-token manager is SHARED, so the derived transport reuses the
     * cached platform token rather than minting one per user. Reached via
     * {@code Realm.withUserToken} — there is deliberately no setter, so a
     * request-scoped identity can never be pinned onto a long-lived transport.
     */
    public HttpTransport withUserToken(String accessJWT) {
        return new HttpTransport(baseUrl, client, mapper, logger, tokens, accessJWT);
    }

    public String baseUrl() { return baseUrl; }
    public ObjectMapper mapper() { return mapper; }
    public HttpClient client() { return client; }

    public JsonNode request(Request r) {
        URI uri = URI.create(baseUrl + (r.path.startsWith("/") ? r.path : "/" + r.path) + buildQuery(r.query));
        HttpRequest.Builder b = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(30));
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("accept", "application/json");

        // Authorization resolution
        String bearer = r.bearer;
        if (bearer == null && !r.skipPlatformToken && tokens != null) {
            bearer = tokens.getToken();
        }
        if (bearer != null) headers.put("authorization", "Bearer " + bearer);
        // The transport-scoped user token is ADDITIVE — the platform token stays
        // the wire bearer (ADR-056). Set before the per-call merge so an explicit
        // header still wins. Per-call names are lower-cased on the way in:
        // HttpRequest.Builder.header() APPENDS, so a differently-cased duplicate
        // would be sent as two values rather than overriding.
        if (userToken != null && !userToken.isEmpty()) headers.put("x-user-token", userToken);
        if (r.headers != null) {
            for (Map.Entry<String, String> e : r.headers.entrySet()) {
                headers.put(e.getKey().toLowerCase(java.util.Locale.ROOT), e.getValue());
            }
        }

        byte[] body = null;
        if (r.body != null) {
            try {
                body = mapper.writeValueAsBytes(r.body);
            } catch (Exception e) {
                throw new RealmException(ErrorCode.BAD_REQUEST, "could not serialize body: " + e.getMessage(), e);
            }
            headers.put("content-type", "application/json");
        }

        String method = r.method == null ? "GET" : r.method;
        if (body == null) {
            b.method(method, HttpRequest.BodyPublishers.noBody());
        } else {
            b.method(method, HttpRequest.BodyPublishers.ofByteArray(body));
        }
        for (Map.Entry<String, String> e : headers.entrySet()) {
            b.header(e.getKey(), e.getValue());
        }

        long start = System.nanoTime();
        if (logger.isLoggable(Level.DEBUG)) {
            logger.log(Level.DEBUG, "realmid: outbound request method={0} path={1} bearer={2}",
                    method, r.path, bearer == null ? "<none>" : Logging.redact(bearer));
        }

        HttpRequest built = b.build();
        HttpResponse<byte[]> resp;
        try {
            resp = sendWithRetry(built);
        } catch (IOException e) {
            if (logger.isLoggable(Level.ERROR)) {
                logger.log(Level.ERROR, "realmid: network error method={0} path={1} message={2}",
                        method, r.path, e.getMessage());
            }
            throw new RealmException(ErrorCode.NETWORK,
                    "network error calling " + method + " " + r.path + ": " + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RealmException(ErrorCode.NETWORK,
                    "interrupted calling " + method + " " + r.path, e);
        }
        long latencyMs = (System.nanoTime() - start) / 1_000_000;

        int status = resp.statusCode();
        byte[] respBytes = resp.body();
        JsonNode parsed = null;
        if (respBytes != null && respBytes.length > 0) {
            try {
                parsed = mapper.readTree(respBytes);
            } catch (IOException e) {
                // non-JSON body
            }
        }

        if (status >= 200 && status < 300) {
            if (logger.isLoggable(Level.DEBUG)) {
                logger.log(Level.DEBUG, "realmid: response method={0} path={1} status={2} latencyMs={3}",
                        method, r.path, status, latencyMs);
            }
            return parsed;
        }

        RealmException ex = mapErrorResponse(status, parsed, method, r.path);
        if (logger.isLoggable(Level.ERROR)) {
            logger.log(Level.ERROR, "realmid: request failed method={0} path={1} status={2} code={3}",
                    method, r.path, status, ex.getCode().wire());
        }
        throw ex;
    }

    /**
     * Send with one retry on EOF — a known JDK HttpClient quirk where a
     * pooled keep-alive socket is closed by the server between requests and
     * the next send sees "header parser received no bytes" before any reply.
     * Idempotent for our usage (auth-id mint + management calls are safe).
     */
    private HttpResponse<byte[]> sendWithRetry(HttpRequest req) throws IOException, InterruptedException {
        IOException last = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            try {
                return client.send(req, HttpResponse.BodyHandlers.ofByteArray());
            } catch (IOException e) {
                if (!isRetriableEof(e)) throw e;
                last = e;
            }
        }
        throw last;
    }

    /**
     * True for the JDK HttpClient keep-alive race: a pooled socket closed by
     * the server between requests surfaces as an EOF / "no bytes" / reset
     * before any reply was read. Safe to retry (idempotent for our usage).
     */
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

    private static RealmException mapErrorResponse(int status, JsonNode body, String method, String path) {
        ErrorCode code = ErrorCode.fromHttpStatus(status);
        String message = method + " " + path + " failed with HTTP " + status;
        Map<String, Object> details = null;

        if (body != null && body.isObject()) {
            JsonNode env = body.get("error");
            if (env != null && env.isObject()) {
                JsonNode sc = env.get("code");
                if (sc != null && sc.isTextual()) {
                    ErrorCode mapped = ErrorCode.fromWire(sc.asText());
                    if (mapped != null) code = mapped;
                }
                JsonNode sm = env.get("message");
                if (sm != null && sm.isTextual() && !sm.asText().isEmpty()) {
                    message = sm.asText();
                }
                Map<String, Object> sib = new LinkedHashMap<>();
                Iterator<Map.Entry<String, JsonNode>> it = body.fields();
                while (it.hasNext()) {
                    Map.Entry<String, JsonNode> e = it.next();
                    if (!"error".equals(e.getKey())) sib.put(e.getKey(), unwrap(e.getValue()));
                }
                if (!sib.isEmpty()) details = sib;
            } else if (body.has("code") && body.get("code").isTextual()) {
                // Flat envelope { "error": "<msg>", "code": "<code>", ...siblings }
                // — the issuer's apiErr.Response() shape, where `error` is a
                // STRING (not a nested object) and the specific code lives at
                // the top level alongside it (most /auth error paths, incl. the
                // ADR-080 contact_admin_required login 409). Read the code here
                // and prefer an explicit `message`, falling back to the `error`
                // string. Mirrors the Go SDK's flat branch (sdk/go/http.go).
                ErrorCode mapped = ErrorCode.fromWire(body.get("code").asText());
                if (mapped != null) code = mapped;
                JsonNode m = body.get("message");
                if (m != null && m.isTextual() && !m.asText().isEmpty()) {
                    message = m.asText();
                } else {
                    JsonNode em = body.get("error");
                    if (em != null && em.isTextual() && !em.asText().isEmpty()) message = em.asText();
                }
                Map<String, Object> sib = new LinkedHashMap<>();
                Iterator<Map.Entry<String, JsonNode>> it = body.fields();
                while (it.hasNext()) {
                    Map.Entry<String, JsonNode> e = it.next();
                    String k = e.getKey();
                    if (!"code".equals(k) && !"message".equals(k) && !"error".equals(k)) {
                        sib.put(k, unwrap(e.getValue()));
                    }
                }
                if (!sib.isEmpty()) details = sib;
            }
        }

        return new RealmException(code, message, status, details);
    }

    private static Object unwrap(JsonNode v) {
        if (v == null || v.isNull()) return null;
        if (v.isTextual()) return v.asText();
        if (v.isInt() || v.isLong()) return v.asLong();
        if (v.isDouble() || v.isFloat()) return v.asDouble();
        if (v.isBoolean()) return v.asBoolean();
        if (v.isArray()) {
            java.util.List<Object> list = new java.util.ArrayList<>(v.size());
            for (JsonNode x : v) list.add(unwrap(x));
            return list;
        }
        if (v.isObject()) {
            Map<String, Object> m = new LinkedHashMap<>();
            Iterator<Map.Entry<String, JsonNode>> it = v.fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                m.put(e.getKey(), unwrap(e.getValue()));
            }
            return m;
        }
        return null;
    }

    private static String buildQuery(Map<String, Object> query) {
        if (query == null || query.isEmpty()) return "";
        StringBuilder sb = new StringBuilder("?");
        boolean first = true;
        for (Map.Entry<String, Object> e : query.entrySet()) {
            if (e.getValue() == null) continue;
            String s = String.valueOf(e.getValue());
            if (s.isEmpty()) continue;
            if (!first) sb.append('&');
            sb.append(URLEncoder.encode(e.getKey(), StandardCharsets.UTF_8))
              .append('=')
              .append(URLEncoder.encode(s, StandardCharsets.UTF_8));
            first = false;
        }
        if (first) return "";
        return sb.toString();
    }

    private static String stripTrailingSlash(String s) {
        int end = s.length();
        while (end > 0 && s.charAt(end - 1) == '/') end--;
        return s.substring(0, end);
    }

    /** Builder-style request descriptor. */
    public static final class Request {
        public String method = "GET";
        public String path;
        public Map<String, Object> query;
        public Object body;
        public String bearer;
        public Map<String, String> headers;
        public boolean skipPlatformToken;

        public Request method(String m) { this.method = m; return this; }
        public Request path(String p) { this.path = p; return this; }
        public Request query(Map<String, Object> q) { this.query = q; return this; }
        public Request body(Object b) { this.body = b; return this; }
        public Request bearer(String t) { this.bearer = t; return this; }
        public Request header(String k, String v) {
            if (headers == null) headers = new HashMap<>();
            headers.put(k, v);
            return this;
        }
        public Request headers(Map<String, String> h) { this.headers = h; return this; }
        public Request skipPlatformToken(boolean v) { this.skipPlatformToken = v; return this; }

        public static Request of(String method, String path) {
            Request r = new Request();
            r.method = method;
            r.path = path;
            return r;
        }
    }
}
