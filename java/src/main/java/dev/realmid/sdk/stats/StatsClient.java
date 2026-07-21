package dev.realmid.sdk.stats;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.http.HttpTransport;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * Platform KPI rollup (issuer v0.52.0).
 *
 * <p>{@code GET /platforms/{pid}/stats} answers the whole dashboard strip —
 * org + user counts, human sign-ins in the trailing 24h, and MFA coverage —
 * from a single server-side query. Authorization is the ADR-074
 * {@code users:read} permission (realm owner and the platform's own
 * service/platform token are implicit-all); RealmID staff get no special path
 * (ADR-067), so a platform you do not own is not readable. The server caches
 * the rollup for 30 seconds, so polling faster returns the same snapshot.
 */
public final class StatsClient {

    private final HttpTransport http;
    private final String realmId;

    public StatsClient(HttpTransport http, String realmId) {
        this.http = http;
        this.realmId = realmId;
    }

    /** GET /platforms/{pid}/stats — the platform KPI rollup (30s server cache). */
    public PlatformStats get() {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "GET",
                "/platforms/" + URLEncoder.encode(realmId, StandardCharsets.UTF_8) + "/stats"));
        if (raw == null) {
            return new PlatformStats();
        }
        return http.mapper().convertValue(raw, PlatformStats.class);
    }
}
