/**
 * Partner-facing audit-event feed (ADR-055) — `GET /platforms/{id}/audit-events`
 * (issuer swagger, "Partner-facing audit-event feed"; SPEC §7.6). Same row
 * shape as `admin.admin.listEvents` (`GET /admin/events`, base-realm-staff
 * only), but scoped and FORCED to `{id}` — a caller cannot read another
 * platform's events even by passing a `platform_id` query param (the issuer
 * ignores it).
 *
 * Auth: a platform admin user JWT, or a platform-scoped service JWT minted
 * from a platform API key. Retention: 400 days.
 *
 * ⚠️ **`@realm-id/sdk` already has an `AuditEventsClient`** (`realm.auditEvents`,
 * SPEC §7.6) — this is a DELIBERATE, DIFFERENT, package-local class, same
 * relationship `ApiKeysClient` has to the bundled one (see `api-keys.ts`):
 * the SPEC's `auditEvents.list(opts?)` is scoped to the SDK's own configured
 * `realmId` and returns one page (`Promise<AuditEventsResponse>`) — right for
 * a partner app that only ever sees its own platform. This admin console
 * needs an EXPLICIT `platformId` per call (RealmID staff and multi-platform
 * partners administer more than one) and the same `Paginated<T>` cursor-walk
 * every other admin list uses (`apiKeys.list`, `tenants.list`, …), so it is
 * not that class reused — it is `ApiKeysClient`'s override shape applied to
 * this route. Do not collapse the two without reading SPEC §7.6 first.
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
