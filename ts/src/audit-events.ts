/**
 * Partner audit-event feed — ADR-055, SPEC §7.6.
 *
 * Cursor-paginated read over the platform's slice of audit_log. Same
 * row shape as the internal /admin/events surface, scoped (and forced)
 * to the platform the SDK is authenticated for — the SDK passes the
 * realm id from config into the URL path, and the server ignores any
 * query-string platform_id, so callers cannot read another platform's
 * events.
 *
 * Retention is 400 days; partners pulling for long-term compliance
 * archives should pull at least quarterly. The cursor is opaque — do
 * not parse it as a timestamp.
 */

import type { HttpClient } from "./http.js";
import type { AuditEvent } from "./admin.js";

export interface AuditEventsResponse {
  items: AuditEvent[];
  next_cursor: string | null;
}

export interface ListAuditEventsOpts {
  tenantId?: string;
  actorId?: string;
  kind?: string[];
  /** Unix seconds. */
  since?: number;
  until?: number;
  /** Opaque cursor returned by the previous page. */
  cursor?: string;
  limit?: number;
}

export class AuditEventsClient {
  constructor(private readonly http: HttpClient, private readonly realmId: string) {}

  async list(opts?: ListAuditEventsOpts): Promise<AuditEventsResponse> {
    const o = opts ?? {};
    const query: Record<string, string | number | undefined> = {
      tenant_id: o.tenantId,
      actor_id: o.actorId,
      cursor: o.cursor,
      limit: o.limit,
    };
    if (o.kind && o.kind.length > 0) query["kind"] = o.kind.join(",");
    if (typeof o.since === "number") query["since"] = o.since;
    if (typeof o.until === "number") query["until"] = o.until;
    return this.http.request<AuditEventsResponse>({
      method: "GET",
      path: `/platforms/${encodeURIComponent(this.realmId)}/audit-events`,
      query,
    });
  }
}
