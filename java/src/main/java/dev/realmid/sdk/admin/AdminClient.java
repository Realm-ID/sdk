package dev.realmid.sdk.admin;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.http.HttpTransport;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Admin aggregates surface (ADR-048, SPEC §7.5).
 *
 * <p>Four read-only endpoints gated server-side on base-realm staff.
 * The SDK does not gate locally — it forwards the platform-token
 * bearer and surfaces the API's {@code 403 forbidden} envelope as
 * {@code RealmException} with {@code ErrorCode.FORBIDDEN}.
 */
public final class AdminClient {

    private final HttpTransport http;

    public AdminClient(HttpTransport http) {
        this.http = http;
    }

    /** GET /admin/platforms. */
    public AdminPlatformsResponse listPlatforms(ListPlatformsOpts opts) {
        Map<String, Object> q = new LinkedHashMap<>();
        if (opts != null) {
            if (opts.q() != null) q.put("q", opts.q());
            if (opts.status() != null && !opts.status().isEmpty()) q.put("status", String.join(",", opts.status()));
            if (opts.signupMode() != null && !opts.signupMode().isEmpty()) q.put("signup_mode", String.join(",", opts.signupMode()));
            if (opts.domain() != null) q.put("domain", opts.domain());
            if (opts.ownerUserId() != null) q.put("owner_user_id", opts.ownerUserId());
            if (opts.hasCustomDomain() != null) q.put("has_custom_domain", opts.hasCustomDomain() ? "true" : "false");
            if (opts.createdAfter() != null) q.put("created_after", opts.createdAfter());
            if (opts.createdBefore() != null) q.put("created_before", opts.createdBefore());
            if (opts.lastActivityAfter() != null) q.put("last_activity_after", opts.lastActivityAfter());
            if (opts.lastActivityBefore() != null) q.put("last_activity_before", opts.lastActivityBefore());
            if (opts.sort() != null) q.put("sort", opts.sort());
            if (opts.cursor() != null) q.put("cursor", opts.cursor());
            if (opts.limit() != null) q.put("limit", opts.limit());
        }
        JsonNode raw = http.request(HttpTransport.Request.of("GET", "/admin/platforms").query(q));
        return http.mapper().convertValue(raw, AdminPlatformsResponse.class);
    }

    public AdminPlatformsResponse listPlatforms() { return listPlatforms(null); }

    /** GET /admin/stats. */
    public AdminStats stats() {
        JsonNode raw = http.request(HttpTransport.Request.of("GET", "/admin/stats"));
        return http.mapper().convertValue(raw, AdminStats.class);
    }

    /** GET /admin/events. */
    public AdminEventsResponse listEvents(ListEventsOpts opts) {
        Map<String, Object> q = new LinkedHashMap<>();
        if (opts != null) {
            if (opts.platformId() != null) q.put("platform_id", opts.platformId());
            if (opts.tenantId() != null) q.put("tenant_id", opts.tenantId());
            if (opts.actorId() != null) q.put("actor_id", opts.actorId());
            if (opts.kind() != null && !opts.kind().isEmpty()) q.put("kind", String.join(",", opts.kind()));
            if (opts.since() != null) q.put("since", opts.since());
            if (opts.until() != null) q.put("until", opts.until());
            if (opts.cursor() != null) q.put("cursor", opts.cursor());
            if (opts.limit() != null) q.put("limit", opts.limit());
        }
        JsonNode raw = http.request(HttpTransport.Request.of("GET", "/admin/events").query(q));
        return http.mapper().convertValue(raw, AdminEventsResponse.class);
    }

    public AdminEventsResponse listEvents() { return listEvents(null); }

    /** GET /admin/search. {@code limit <= 0} omits the param (server default applies). */
    public AdminSearchResponse search(String q, int limit) {
        Map<String, Object> qs = new LinkedHashMap<>();
        if (q != null && !q.isEmpty()) qs.put("q", q);
        if (limit > 0) qs.put("limit", limit);
        JsonNode raw = http.request(HttpTransport.Request.of("GET", "/admin/search").query(qs));
        return http.mapper().convertValue(raw, AdminSearchResponse.class);
    }

    public AdminSearchResponse search(String q) { return search(q, 0); }

    // ---- DTOs (records mapped via Jackson) ----

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record PlatformOwner(
            @JsonProperty("user_id") String userId,
            String name,
            String email
    ) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record PlatformSummary(
            String id,
            @JsonProperty("display_name") String displayName,
            String slug,
            String status,
            @JsonProperty("signup_mode") String signupMode,
            List<String> domains,
            PlatformOwner owner,
            @JsonProperty("tenants_count") int tenantsCount,
            @JsonProperty("users_count") int usersCount,
            @JsonProperty("last_activity_at") long lastActivityAt,
            @JsonProperty("created_at") long createdAt
    ) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record AdminPlatformsResponse(
            List<PlatformSummary> items,
            @JsonProperty("next_cursor") String nextCursor,
            int total
    ) {}

    /**
     * GET /admin/stats — the base-realm fleet rollup.
     *
     * <p>The platforms* counts exclude the base realm (matching
     * GET /admin/platforms), so active+suspended &lt; platformsCount means the
     * remainder is deactivated.
     *
     * <p>sessionsActive is a point-in-time gauge (live sessions, all classes);
     * sessions24h is a flow — class='user' sessions CREATED in the trailing
     * 24h, i.e. human sign-ins. Deliberately not "tokens": a refresh mints a
     * token without creating a session.
     *
     * <p>The four fields added in issuer v0.52.0 decode as 0 against an older
     * issuer that does not emit them.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record AdminStats(
            @JsonProperty("platforms_count") int platformsCount,
            @JsonProperty("platforms_active") int platformsActive,
            @JsonProperty("platforms_suspended") int platformsSuspended,
            @JsonProperty("platforms_new_7d") int platformsNew7d,
            @JsonProperty("tenants_count") int tenantsCount,
            @JsonProperty("users_count") int usersCount,
            @JsonProperty("sessions_active") int sessionsActive,
            @JsonProperty("sessions_24h") int sessions24h,
            @JsonProperty("events_24h") int events24h
    ) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record AuditEvent(
            long id,
            @JsonProperty("occurred_at") long occurredAt,
            String kind,
            @JsonProperty("actor_user_id") String actorUserId,
            @JsonProperty("actor_label") String actorLabel,
            @JsonProperty("platform_id") String platformId,
            @JsonProperty("tenant_id") String tenantId,
            @JsonProperty("target_type") String targetType,
            @JsonProperty("target_id") String targetId,
            String summary
    ) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record AdminEventsResponse(
            List<AuditEvent> items,
            @JsonProperty("next_cursor") String nextCursor
    ) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record SearchHit(
            String type,
            String id,
            String label,
            String sublabel,
            @JsonProperty("platform_id") String platformId
    ) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record AdminSearchResponse(List<SearchHit> items) {}

    // ---- option records ----

    /** Filters for {@link #listPlatforms(ListPlatformsOpts)}. Build with {@link Builder}. */
    public record ListPlatformsOpts(
            String q,
            List<String> status,
            List<String> signupMode,
            String domain,
            String ownerUserId,
            Boolean hasCustomDomain,
            Long createdAfter,
            Long createdBefore,
            Long lastActivityAfter,
            Long lastActivityBefore,
            String sort,
            String cursor,
            Integer limit
    ) {
        public static Builder builder() { return new Builder(); }

        public static final class Builder {
            private String q;
            private List<String> status;
            private List<String> signupMode;
            private String domain;
            private String ownerUserId;
            private Boolean hasCustomDomain;
            private Long createdAfter;
            private Long createdBefore;
            private Long lastActivityAfter;
            private Long lastActivityBefore;
            private String sort;
            private String cursor;
            private Integer limit;

            public Builder q(String v) { this.q = v; return this; }
            public Builder status(List<String> v) { this.status = v; return this; }
            public Builder signupMode(List<String> v) { this.signupMode = v; return this; }
            public Builder domain(String v) { this.domain = v; return this; }
            public Builder ownerUserId(String v) { this.ownerUserId = v; return this; }
            public Builder hasCustomDomain(Boolean v) { this.hasCustomDomain = v; return this; }
            public Builder createdAfter(Long v) { this.createdAfter = v; return this; }
            public Builder createdBefore(Long v) { this.createdBefore = v; return this; }
            public Builder lastActivityAfter(Long v) { this.lastActivityAfter = v; return this; }
            public Builder lastActivityBefore(Long v) { this.lastActivityBefore = v; return this; }
            public Builder sort(String v) { this.sort = v; return this; }
            public Builder cursor(String v) { this.cursor = v; return this; }
            public Builder limit(Integer v) { this.limit = v; return this; }

            public ListPlatformsOpts build() {
                return new ListPlatformsOpts(q, status, signupMode, domain, ownerUserId,
                        hasCustomDomain, createdAfter, createdBefore,
                        lastActivityAfter, lastActivityBefore, sort, cursor, limit);
            }
        }
    }

    /** Filters for {@link #listEvents(ListEventsOpts)}. Build with {@link Builder}. */
    public record ListEventsOpts(
            String platformId,
            String tenantId,
            String actorId,
            List<String> kind,
            Long since,
            Long until,
            String cursor,
            Integer limit
    ) {
        public static Builder builder() { return new Builder(); }

        public static final class Builder {
            private String platformId;
            private String tenantId;
            private String actorId;
            private List<String> kind;
            private Long since;
            private Long until;
            private String cursor;
            private Integer limit;

            public Builder platformId(String v) { this.platformId = v; return this; }
            public Builder tenantId(String v) { this.tenantId = v; return this; }
            public Builder actorId(String v) { this.actorId = v; return this; }
            public Builder kind(List<String> v) { this.kind = v; return this; }
            public Builder since(Long v) { this.since = v; return this; }
            public Builder until(Long v) { this.until = v; return this; }
            public Builder cursor(String v) { this.cursor = v; return this; }
            public Builder limit(Integer v) { this.limit = v; return this; }

            public ListEventsOpts build() {
                return new ListEventsOpts(platformId, tenantId, actorId, kind,
                        since, until, cursor, limit);
            }
        }
    }
}
