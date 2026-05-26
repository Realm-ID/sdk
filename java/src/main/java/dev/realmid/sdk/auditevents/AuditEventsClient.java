package dev.realmid.sdk.auditevents;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.http.HttpTransport;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Partner audit-event feed (ADR-055, SPEC §7.6).
 *
 * <p>Cursor-paginated read over the platform's slice of audit_log. Same
 * row shape as the internal /admin/events surface, scoped (and forced)
 * to the platform the SDK is authenticated for — the SDK passes the
 * configured {@code realmId} into the URL path and the server ignores
 * any query-string {@code platform_id}, so callers cannot read another
 * platform's events.
 *
 * <p>Retention is 400 days; partners pulling for long-term compliance
 * archives should pull at least quarterly. The cursor is opaque — do
 * not parse it as a timestamp.
 */
public final class AuditEventsClient {

    private final HttpTransport http;
    private final String realmId;

    public AuditEventsClient(HttpTransport http, String realmId) {
        this.http = http;
        this.realmId = realmId;
    }

    /** GET /platforms/{id}/audit-events. */
    public AuditEventsResponse list(ListAuditEventsOpts opts) {
        Map<String, Object> q = new LinkedHashMap<>();
        if (opts != null) {
            if (opts.tenantId() != null) q.put("tenant_id", opts.tenantId());
            if (opts.actorId() != null) q.put("actor_id", opts.actorId());
            if (opts.kind() != null && !opts.kind().isEmpty()) q.put("kind", String.join(",", opts.kind()));
            if (opts.since() != null) q.put("since", opts.since());
            if (opts.until() != null) q.put("until", opts.until());
            if (opts.cursor() != null) q.put("cursor", opts.cursor());
            if (opts.limit() != null) q.put("limit", opts.limit());
        }
        JsonNode raw = http.request(HttpTransport.Request.of("GET", "/platforms/" + realmId + "/audit-events").query(q));
        return http.mapper().convertValue(raw, AuditEventsResponse.class);
    }

    public AuditEventsResponse list() { return list(null); }

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
    public record AuditEventsResponse(
            List<AuditEvent> items,
            @JsonProperty("next_cursor") String nextCursor
    ) {}

    /** Filters for {@link #list(ListAuditEventsOpts)}. Build with {@link Builder}. */
    public record ListAuditEventsOpts(
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
            private String tenantId;
            private String actorId;
            private List<String> kind;
            private Long since;
            private Long until;
            private String cursor;
            private Integer limit;
            public Builder tenantId(String v) { this.tenantId = v; return this; }
            public Builder actorId(String v) { this.actorId = v; return this; }
            public Builder kind(List<String> v) { this.kind = v; return this; }
            public Builder since(Long v) { this.since = v; return this; }
            public Builder until(Long v) { this.until = v; return this; }
            public Builder cursor(String v) { this.cursor = v; return this; }
            public Builder limit(Integer v) { this.limit = v; return this; }
            public ListAuditEventsOpts build() {
                return new ListAuditEventsOpts(tenantId, actorId, kind, since, until, cursor, limit);
            }
        }
    }
}
