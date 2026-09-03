/**
 * Sources — `realm.sources.*` (ADR-072).
 *
 * A source is a platform-level client app (web/android/ios/desktop human app,
 * or the `bot` service-account app). Its `allowed_methods` is mapping-2 — the
 * login methods that app surfaces. A `bot` source may list only `otp`; a human
 * source may never list `otp` (mapping-1 invariant, ADR-072 §0).
 *
 * Authorization is the realm's short-lived platform token (auto-attached by the
 * HttpClient), like the Roles/ServiceAccounts clients.
 *
 * Server error code `method_violates_kind` (400) surfaces on `RealmError.code`;
 * a missing source surfaces as `source_not_found` / `not_found`.
 */

import type { HttpClient } from "./http.js";
import { paginate, readPage, type Paginated, type PageOpts } from "./pagination.js";

/** One app/source registration (issuer sourceDTO). */
export interface Source {
  id: string;
  platform_id: string;
  type: string;
  label: string;
  allowed_methods: string[];
  enabled: boolean;
  created_at: number;
  [k: string]: unknown;
}

/** POST /sources body. `platformId` defaults to the realm. */
export interface SourceCreate {
  platformId?: string;
  type: string;
  label: string;
  allowedMethods?: string[];
}

/** PATCH /sources/{id} body — omitted fields are left unchanged. */
export interface SourcePatch {
  label?: string;
  allowedMethods?: string[];
  enabled?: boolean;
}

export class SourcesClient {
  constructor(
    private readonly http: HttpClient,
    private readonly realmId: string,
  ) {}

  /**
   * GET /sources?platform_id={realmId} — the realm's sources, disabled ones
   * included.
   *
   * Returns the PAGER, not an array: the endpoint is paginated server-side, so
   * an array could only ever be page one with no way for the caller to tell it
   * was cut short. `for await` walks every page; `.page({cursor, limit})` gives
   * one page plus `hasMore`/`nextCursor`/`total`.
   */
  list(opts?: PageOpts): Paginated<Source> {
    return paginate<Source>(async (po) => {
      const raw = await this.http.request<unknown>({
        method: "GET",
        path: "/sources",
        query: {
          platform_id: this.realmId,
          cursor: po.cursor,
          limit: po.limit ?? opts?.limit,
        },
      });
      return readPage<Source>(raw);
    });
  }

  /** POST /sources — register a new app/source. `platformId` defaults to the realm. */
  async create(body: SourceCreate): Promise<Source> {
    const wire: Record<string, unknown> = {
      platform_id: body.platformId ?? this.realmId,
      type: body.type,
      label: body.label,
    };
    if (body.allowedMethods !== undefined) wire["allowed_methods"] = body.allowedMethods;
    return this.http.request<Source>({
      method: "POST",
      path: "/sources",
      body: wire,
    });
  }

  /**
   * PATCH /sources/{id} — sparse update. `allowedMethods` is re-validated
   * against the source's type server-side (mapping-2 can never weaken
   * mapping-1).
   */
  async update(id: string, patch: SourcePatch): Promise<Source> {
    const wire: Record<string, unknown> = {};
    if (patch.label !== undefined) wire["label"] = patch.label;
    if (patch.allowedMethods !== undefined) wire["allowed_methods"] = patch.allowedMethods;
    if (patch.enabled !== undefined) wire["enabled"] = patch.enabled;
    return this.http.request<Source>({
      method: "PATCH",
      path: `/sources/${encodeURIComponent(id)}`,
      body: wire,
    });
  }

  /** DELETE /sources/{id}. */
  async delete(id: string): Promise<void> {
    await this.http.request({
      method: "DELETE",
      path: `/sources/${encodeURIComponent(id)}`,
    });
  }
}
