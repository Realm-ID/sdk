package dev.realmid.sdk.split;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import dev.realmid.sdk.http.HttpTransport;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The ready-made integration-token handler (SPEC 14.8; R47, R50, R67.2; mirrors sdk/go integration_handler.go),
 * framework-neutral: a servlet or HTTP-server adapter calls {@link #handle} and writes the {@link Response}.
 * It rate-limits per client, then calls the TARGET realm's token endpoint with
 * {@code grant_type=integration_installation}, the target's platform token as bearer and the pass in
 * {@code X-User-Token} (never in a body). On a split target it finishes the half-signed answer; otherwise it
 * relays the issuer's status and body verbatim. It does no authorization of its own.
 */
public final class IntegrationTokenHandler {
    private static final int DEFAULT_RATE = 30;
    private static final int BODY_MAX = 8 << 10;
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Status, headers and JSON body to write back. */
    public record Response(int status, Map<String, String> headers, String body) {
        public Response(int status, String body) { this(status, Map.of(), body); }
    }

    private final Realm realm;
    private final int rate;
    private final java.util.function.Function<String, String> clientKey;
    private final Clock clock;
    private final Map<String, long[]> hits = new HashMap<>(); // key -> {windowStartMillis, count}

    public IntegrationTokenHandler(Realm realm, IntegrationHandlerOptions opts) {
        this.realm = realm;
        this.rate = opts == null || opts.ratePerMinute() <= 0 ? DEFAULT_RATE : opts.ratePerMinute();
        this.clientKey = opts == null ? null : opts.clientKey();
        this.clock = realm.clock();
    }

    private synchronized boolean allow(String key) {
        long now = clock.millis();
        hits.values().removeIf(w -> now - w[0] >= 60_000);
        long[] w = hits.computeIfAbsent(key, k -> new long[] {now, 0});
        return ++w[1] <= rate;
    }

    private static String hostOf(String addr) {
        if (addr == null) return "";
        if (addr.startsWith("[")) {
            int end = addr.indexOf(']');
            return end > 0 ? addr.substring(1, end) : addr;
        }
        int c = addr.lastIndexOf(':');
        return c > 0 && addr.indexOf(':') == c ? addr.substring(0, c) : addr;
    }

    private static Response error(int status, String code, String msg, Map<String, String> extra) {
        Map<String, String> h = new LinkedHashMap<>(extra);
        h.put("Content-Type", "application/json");
        ObjectNode e = JSON.createObjectNode();
        e.putObject("error").put("code", code).put("message", msg);
        return new Response(status, h, e.toString());
    }

    /** {@code remoteAddr} keys the rate limit; {@code body} is {@code {"pass": "..."}}. */
    public Response handle(String httpMethod, String remoteAddr, String body) {
        if (!"POST".equalsIgnoreCase(httpMethod)) {
            return error(405, "method_not_allowed", "POST only", Map.of("Allow", "POST"));
        }
        String key = clientKey != null ? clientKey.apply(remoteAddr) : hostOf(remoteAddr);
        if (!allow(key == null ? "" : key)) {
            return error(429, "rate_limited", "too many requests", Map.of("Retry-After", "60"));
        }
        String pass = null;
        if (body != null && body.getBytes(StandardCharsets.UTF_8).length <= BODY_MAX) {
            try {
                JsonNode n = JSON.readTree(body);
                if (n != null && n.path("pass").isTextual()) pass = n.get("pass").asText();
            } catch (Exception ignored) {
                // falls through to the 400 below
            }
        }
        if (pass == null || pass.isEmpty()) {
            return error(400, "bad_request", "body must be {\"pass\": \"<install pass>\"}", Map.of());
        }
        SplitState split = realm.splitState();
        boolean isSplit = split != null && split.isSplit();
        Map<String, Object> req = new LinkedHashMap<>();
        req.put("realm_id", realm.realmId());
        req.put("grant_type", "integration_installation");
        HttpTransport.Raw raw;
        try {
            raw = realm.http().withUserToken(null).requestRaw(
                    HttpTransport.Request.of("POST", isSplit ? "/auth/token/partial" : "/auth/token")
                            .body(req).header("x-user-token", pass).noRetry());
        } catch (RealmException e) {
            return error(502, "upstream_unavailable", "the token endpoint could not be reached", Map.of());
        }
        String text = new String(raw.body(), StandardCharsets.UTF_8);
        if (!isSplit || raw.status() / 100 != 2) {
            Map<String, String> h = new LinkedHashMap<>();
            if (raw.contentType() != null) h.put("Content-Type", raw.contentType());
            if (raw.retryAfter() != null) h.put("Retry-After", raw.retryAfter());
            h.put("Cache-Control", "no-store");
            return new Response(raw.status(), h, text);
        }
        try {
            JsonNode answer = JSON.readTree(text);
            JsonNode s = answer.get("signing");
            if (s == null || !"partial".equals(answer.path("token_type").asText(null))) throw new IllegalStateException();
            String kid = s.path("kid").asText("");
            String jwt = CoSigner.coSign(split.entry(kid), split.expectedIssuer(), new PartialSigning(kid,
                    s.path("header").asText(null), s.path("payload").asText(null), s.path("partial_ri").asText(null)));
            split.noteExpiresIn(answer.path("expires_in").asLong(0));
            ObjectNode out = ((ObjectNode) answer).deepCopy();
            out.remove("signing");
            out.put("access_token", jwt);
            out.put("token_type", "Bearer");
            Map<String, String> h = new LinkedHashMap<>();
            h.put("Content-Type", "application/json");
            h.put("Cache-Control", "no-store");
            return new Response(200, h, out.toString());
        } catch (Exception e) {
            return error(502, "cosign_failed", "the half-signed token could not be completed", Map.of());
        }
    }

}
