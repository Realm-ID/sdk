package dev.realmid.sdk.info;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.http.HttpTransport;

import java.util.Iterator;
import java.util.Map;

/**
 * Caches realm metadata (SPEC §1 audience auto-discovery; SPEC §6.5).
 * Source of truth: {@code GET /platforms/mine}.
 */
public final class RealmInfoClient {
    private final HttpTransport http;
    private final String realmId;
    private final boolean hasApiKey;
    private volatile RealmInfo cached;

    public RealmInfoClient(HttpTransport http, String realmId, boolean hasApiKey) {
        this.http = http;
        this.realmId = realmId;
        this.hasApiKey = hasApiKey;
    }

    /** Cached for the lifetime of the handle. */
    public synchronized RealmInfo info() {
        if (cached != null) return cached;
        cached = fetch();
        return cached;
    }

    public synchronized void invalidate() { cached = null; }

    private RealmInfo fetch() {
        if (hasApiKey) {
            try {
                JsonNode raw = http.request(HttpTransport.Request.of("GET", "/platforms/mine"));
                RealmInfo found = findRealmIn(raw, realmId);
                if (found != null) return found;
            } catch (RuntimeException ignored) {
                // fall through to stub
            }
        }
        return new RealmInfo(realmId, "", null);
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
            if (idNode != null && idNode.isTextual() && wantedId.equals(idNode.asText())) {
                JsonNode aud = node.get("audience");
                if (aud == null || !aud.isTextual()) aud = node.get("domain");
                if (aud != null && aud.isTextual()) {
                    String dn = node.has("display_name") && node.get("display_name").isTextual()
                            ? node.get("display_name").asText()
                            : null;
                    return new RealmInfo(wantedId, aud.asText(), dn);
                }
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
