/**
 * Partner-facing audit-event feed (ADR-055) — `GET /platforms/{id}/audit-events`
 * (issuer swagger, "Partner-facing audit-event feed"). Same row shape as
 * `admin.admin.listEvents` (`GET /admin/events`, base-realm-staff only), but
 * scoped and FORCED to `{id}` — a caller cannot read another platform's
 * events even by passing a `platform_id` query param (the issuer ignores it).
 *
 * Auth: a platform admin user JWT, or a platform-scoped service JWT minted
 * from a platform API key. Retention: 400 days.
 *
 * Replaces the hand-rolled `fetchPlatformAuditEvents` shim
 * (`ui/web/src/api.ts`).
 */

import { paginate, readPage, type Paginated, type PageOpts } from "@realm-id/sdk";
import type { AuditEvent, AdminEventsResponse } from "@realm-id/sdk/internal";
import type { HttpLike } from "./transport.js";

/** Optional filters for {@link AuditEventsClient.list}. */
export interface AuditEventsListOpts {
  tenantId?: string;
  actorId?: string;
  /** Repeatable server-side: matches any of the supplied kinds. */
  kind?: string | string[];
  /** Unix seconds, inclusive lower bound on `occurred_at`. */
  since?: number;
  /** Unix seconds, inclusive upper bound on `occurred_at`. */
  until?: number;
}

export class AuditEventsClient {
  constructor(private readonly http: HttpLike) {}

  /**
   * Paginate a platform's audit-event feed. Returns the PAGER, not an array —
   * same rationale as {@link ApiKeysClient.list}: the route is server-paginated
   * (default page 50, max 200), so an array could only ever be page one.
   * `for await` walks every page; `.page({cursor, limit})` gives one page.
   */
  list(platformId: string, opts?: AuditEventsListOpts & PageOpts): Paginated<AuditEvent> {
    const path = `/platforms/${encodeURIComponent(platformId)}/audit-events`;
    const kind = Array.isArray(opts?.kind) ? opts.kind.join(",") : opts?.kind;
    return paginate<AuditEvent>(async (po) => {
      const raw = await this.http.request<AdminEventsResponse>({
        method: "GET",
        path,
        query: {
          tenant_id: opts?.tenantId,
          actor_id: opts?.actorId,
          kind,
          since: opts?.since,
          until: opts?.until,
          cursor: po.cursor,
          limit: po.limit ?? opts?.limit,
        },
      });
      return readPage<AuditEvent>(raw);
    });
  }
}
