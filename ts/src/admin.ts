/**
 * Admin aggregates surface — ADR-048, SPEC §7.5.
 *
 * Four read-only endpoints gated server-side on base-realm staff. The
 * SDK does not gate locally — it forwards the platform-token bearer
 * and surfaces the API's `403 forbidden` envelope as
 * `RealmError({ code: "forbidden" })`.
 */

import type { HttpClient } from "./http.js";

export interface PlatformOwner {
  user_id: string;
  name: string;
  email: string;
}

export interface PlatformSummary {
  id: string;
  display_name: string;
  slug: string;
  status: string;
  signup_mode: string;
  domains: string[];
  owner: PlatformOwner;
  tenants_count: number;
  users_count: number;
  /** Unix seconds. */
  last_activity_at: number;
  /** Unix seconds. */
  created_at: number;
}

export interface AdminPlatformsResponse {
  items: PlatformSummary[];
  next_cursor: string | null;
  total: number;
}

export interface AdminStats {
  platforms_count: number;
  tenants_count: number;
  users_count: number;
  sessions_active: number;
  events_24h: number;
}

export interface AuditEvent {
  id: number;
  /** Unix seconds. */
  occurred_at: number;
  kind: string;
  actor_user_id?: string;
  actor_label?: string;
  platform_id?: string;
  tenant_id?: string;
  target_type?: string;
  target_id?: string;
  summary?: string;
}

export interface AdminEventsResponse {
  items: AuditEvent[];
  next_cursor: string | null;
}

export interface SearchHit {
  type: "platform" | "tenant";
  id: string;
  label: string;
  sublabel?: string;
  platform_id?: string;
}

export interface AdminSearchResponse {
  items: SearchHit[];
}

export interface ListPlatformsOpts {
  q?: string;
  status?: string[];
  signupMode?: string[];
  domain?: string;
  ownerUserId?: string;
  hasCustomDomain?: boolean;
  /** Unix seconds. */
  createdAfter?: number;
  createdBefore?: number;
  lastActivityAfter?: number;
  lastActivityBefore?: number;
  sort?: string;
  cursor?: string;
  limit?: number;
}

export interface ListEventsOpts {
  platformId?: string;
  tenantId?: string;
  actorId?: string;
  kind?: string[];
  /** Unix seconds. */
  since?: number;
  until?: number;
  cursor?: string;
  limit?: number;
}

export class AdminClient {
  constructor(private readonly http: HttpClient) {}

  async listPlatforms(opts?: ListPlatformsOpts): Promise<AdminPlatformsResponse> {
    const o = opts ?? {};
    const query: Record<string, string | number | undefined> = {
      q: o.q,
      domain: o.domain,
      owner_user_id: o.ownerUserId,
      sort: o.sort,
      cursor: o.cursor,
      limit: o.limit,
    };
    if (o.status && o.status.length > 0) query["status"] = o.status.join(",");
    if (o.signupMode && o.signupMode.length > 0) query["signup_mode"] = o.signupMode.join(",");
    if (typeof o.hasCustomDomain === "boolean") query["has_custom_domain"] = o.hasCustomDomain ? "true" : "false";
    if (typeof o.createdAfter === "number") query["created_after"] = o.createdAfter;
    if (typeof o.createdBefore === "number") query["created_before"] = o.createdBefore;
    if (typeof o.lastActivityAfter === "number") query["last_activity_after"] = o.lastActivityAfter;
    if (typeof o.lastActivityBefore === "number") query["last_activity_before"] = o.lastActivityBefore;
    return this.http.request<AdminPlatformsResponse>({
      method: "GET",
      path: "/admin/platforms",
      query,
    });
  }

  async stats(): Promise<AdminStats> {
    return this.http.request<AdminStats>({
      method: "GET",
      path: "/admin/stats",
    });
  }

  async listEvents(opts?: ListEventsOpts): Promise<AdminEventsResponse> {
    const o = opts ?? {};
    const query: Record<string, string | number | undefined> = {
      platform_id: o.platformId,
      tenant_id: o.tenantId,
      actor_id: o.actorId,
      cursor: o.cursor,
      limit: o.limit,
    };
    if (o.kind && o.kind.length > 0) query["kind"] = o.kind.join(",");
    if (typeof o.since === "number") query["since"] = o.since;
    if (typeof o.until === "number") query["until"] = o.until;
    return this.http.request<AdminEventsResponse>({
      method: "GET",
      path: "/admin/events",
      query,
    });
  }

  async search(q: string, limit?: number): Promise<AdminSearchResponse> {
    const query: Record<string, string | number | undefined> = {};
    if (q) query["q"] = q;
    if (typeof limit === "number" && limit > 0) query["limit"] = limit;
    return this.http.request<AdminSearchResponse>({
      method: "GET",
      path: "/admin/search",
      query,
    });
  }
}
