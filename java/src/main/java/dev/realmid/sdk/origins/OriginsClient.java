package dev.realmid.sdk.origins;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;
import dev.realmid.sdk.http.HttpTransport;
import dev.realmid.sdk.pagination.Page;
import dev.realmid.sdk.pagination.PageOpts;
import dev.realmid.sdk.pagination.PageReader;
import dev.realmid.sdk.pagination.Paginated;
import dev.realmid.sdk.platformtoken.PlatformTokenManager;

import java.time.Clock;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Origin allowlist enforcement (ADR-047 §1.1, ADR-049 §A.7.2).
 *
 * Partner backends fronting RealmID's platform-token-gated routes
 * validate the inbound {@code Origin} header through this client
 * before forwarding the call. The per-realm allowlist is cached for
 * 5 minutes and refreshed on miss / 401.
 */
public final class OriginsClient {

    private static final long CACHE_TTL_MILLIS = 5L * 60L * 1000L;

    private final HttpTransport http;
    private final PlatformTokenManager tokens;
    private final Clock clock;

    private final ConcurrentHashMap<String, CacheEntry> cache = new ConcurrentHashMap<>();

    public OriginsClient(HttpTransport http, PlatformTokenManager tokens, Clock clock) {
        this.http = http;
        this.tokens = tokens;
        this.clock = clock == null ? Clock.systemUTC() : clock;
    }

    /** Lowercase, strip scheme/port/path — mirrors {@code domainmapping.Normalize}. */
    public static String normalize(String raw) {
        if (raw == null) return "";
        String s = raw.trim().toLowerCase();
        if (s.startsWith("https://")) s = s.substring("https://".length());
        else if (s.startsWith("http://")) s = s.substring("http://".length());
        int slash = s.indexOf('/');
        if (slash >= 0) s = s.substring(0, slash);
        int colon = s.indexOf(':');
        if (colon >= 0) s = s.substring(0, colon);
        return s;
    }

    /** SPEC §7 paginated list of live mappings for the realm. */
    public Paginated<Origin> list(String realmId) {
        if (realmId == null || realmId.isEmpty()) {
            throw new RealmException(ErrorCode.BAD_REQUEST, "origins.list: realmId required");
        }
        return Paginated.of(opts -> fetchPage(realmId, opts));
    }

    /**
     * Returns true iff the supplied origin (after normalization) appears
     * in the realm's cached allowlist. Refreshes the cache on miss /
     * TTL expiry, retries once on 401.
     */
    public boolean validate(String realmId, String origin) {
        if (realmId == null || realmId.isEmpty()) {
            throw new RealmException(ErrorCode.BAD_REQUEST, "origins.validate: realmId required");
        }
        String norm = normalize(origin);
        if (norm.isEmpty()) return false;
        Set<String> allow = allowlistFor(realmId);
        return allow.contains(norm);
    }

    /** Drop the cached allowlist for one realm (or all if null). */
    public void invalidate(String realmId) {
        if (realmId == null) cache.clear();
        else cache.remove(realmId);
    }

    private Set<String> allowlistFor(String realmId) {
        long now = clock.millis();
        CacheEntry hit = cache.get(realmId);
        if (hit != null && now - hit.fetchedAtMillis < CACHE_TTL_MILLIS) {
            return hit.allowlist;
        }
        Set<String> fresh = fetchAllowlist(realmId);
        cache.put(realmId, new CacheEntry(fresh, clock.millis()));
        return fresh;
    }

    private Set<String> fetchAllowlist(String realmId) {
        Set<String> out = new HashSet<>();
        String cursor = null;
        while (true) {
            PageOpts opts = cursor == null ? PageOpts.empty() : PageOpts.withCursor(cursor);
            Page<Origin> page = fetchPage(realmId, opts);
            for (Origin row : page.items()) {
                if (row.detachedAt() != null && !row.detachedAt().isEmpty()) continue;
                String d = normalize(row.domain());
                if (!d.isEmpty()) out.add(d);
            }
            if (page.nextCursor() == null || page.nextCursor().isEmpty()) return out;
            cursor = page.nextCursor();
        }
    }

    private Page<Origin> fetchPage(String realmId, PageOpts opts) {
        try {
            return doListCall(realmId, opts);
        } catch (RealmException e) {
            if (e.getCode() == ErrorCode.UNAUTHORIZED && tokens != null) {
                tokens.invalidate();
                return doListCall(realmId, opts);
            }
            throw e;
        }
    }

    private Page<Origin> doListCall(String realmId, PageOpts opts) {
        Map<String, Object> q = new LinkedHashMap<>();
        if (opts != null) {
            if (opts.cursor() != null && !opts.cursor().isEmpty()) q.put("cursor", opts.cursor());
            if (opts.limit() != null) q.put("limit", opts.limit());
        }
        JsonNode raw = http.request(HttpTransport.Request.of("GET",
                "/platforms/" + realmId + "/origins").query(q));
        return PageReader.read(http.mapper(), raw, Origin.class);
    }

    private static final class CacheEntry {
        final Set<String> allowlist;
        final long fetchedAtMillis;
        CacheEntry(Set<String> allowlist, long fetchedAtMillis) {
            this.allowlist = allowlist;
            this.fetchedAtMillis = fetchedAtMillis;
        }
    }

    /** ADR-049 §A.7.2 row shape. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Origin(
            String id,
            String domain,
            @JsonProperty("entity_type") String entityType,
            @JsonProperty("entity_id") String entityId,
            @JsonProperty("verification_id") String verificationId,
            @JsonProperty("created_at") String createdAt,
            @JsonProperty("detached_at") String detachedAt) {}
}
