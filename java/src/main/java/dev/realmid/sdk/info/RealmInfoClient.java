package dev.realmid.sdk.info;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.http.HttpTransport;

import java.time.Clock;
import java.util.Iterator;
import java.util.Map;

/**
 * Caches realm metadata (SPEC §1 audience auto-discovery; SPEC §6.5).
 * Source of truth: {@code GET /platforms/mine}.
 *
 * <p>A successful result is cached for the life of the handle. A failed
 * discovery (transport error, non-2xx, a response without the realm, or a
 * realm row without an audience) is never cached: the call that hit it gets
 * the empty stub, and a later call retries, at most once per 30 seconds.
 */
public final class RealmInfoClient {
    private static final long RETRY_MS = 30_000L;

    private final HttpTransport http;
    private final String realmId;
    private final boolean hasApiKey;
    private final Clock clock;
    private volatile RealmInfo cached;
    private long lastFailureMs;
    private boolean failed;

    public RealmInfoClient(HttpTransport http, String realmId, boolean hasApiKey) {
        this(http, realmId, hasApiKey, Clock.systemUTC());
    }

    public RealmInfoClient(HttpTransport http, String realmId, boolean hasApiKey, Clock clock) {
        this.http = http;
        this.realmId = realmId;
        this.hasApiKey = hasApiKey;
        this.clock = clock == null ? Clock.systemUTC() : clock;
    }

    /** A success is cached for the lifetime of the handle; a failure is retried after 30 s. */
    public synchronized RealmInfo info() {
        if (cached != null) return cached;
        if (failed && clock.millis() - lastFailureMs < RETRY_MS) return stub();
        RealmInfo found = fetch();
        if (found == null) {
            failed = true;
            lastFailureMs = clock.millis();
            return stub();
        }
        failed = false;
        cached = found;
        return cached;
    }

    public synchronized void invalidate() {
        cached = null;
        failed = false;
    }

    private RealmInfo stub() { return new RealmInfo(realmId, "", null); }

    private RealmInfo fetch() {
        if (!hasApiKey) return null;
        try {
            JsonNode raw = http.request(HttpTransport.Request.of("GET", "/platforms/mine"));
            return findRealmIn(raw, realmId);
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private RealmInfo findRealmIn(JsonNode node, String wantedId) {
        if (node == null) return null;
        if (node.isArray()) {
            for (JsonNode x : node) {
                RealmInfo r = findRealmIn(x, wantedId);
                if (r != null) return r;
            }
            return null;
        }
        if (node.isObject()) {
            JsonNode idNode = node.get("id");
            if (idNode != null && idNode.isTextual() && wantedId.equals(idNode.asText())
                    && (node.has("audience") || node.has("domain"))) {
                // A realm always has an audience; it is never derived from the domain.
                JsonNode aud = node.get("audience");
                if (aud == null || !aud.isTextual() || aud.asText().isEmpty()) return null;
                String dn = node.has("display_name") && node.get("display_name").isTextual()
                        ? node.get("display_name").asText()
                        : null;
                String oe = node.has("origin_enforcement") && node.get("origin_enforcement").isTextual()
                        ? node.get("origin_enforcement").asText()
                        : null;
                return new RealmInfo(wantedId, aud.asText(), dn, oe);
            }
            Iterator<Map.Entry<String, JsonNode>> it = node.fields();
            while (it.hasNext()) {
                RealmInfo r = findRealmIn(it.next().getValue(), wantedId);
                if (r != null) return r;
            }
        }
        return null;
    }
}
