/**
 * BFF aggregate routes — `/home` (post-login dashboard fan-out) and
 * `/tenants/{id}/full` (tenant detail + audit events). Both hit the
 * BFF's typed surface directly, no `/api` prefix. See
 * `ui/web/src/api.ts:1131-1147`.
 */

import type { HttpLike } from "./transport.js";
import type { HomeResponse, TenantFullResponse } from "./types.js";

export class BffClient {
  constructor(private readonly http: HttpLike) {}

  async home(opts: { mode?: "ops" | "customer" } = {}): Promise<HomeResponse> {
    return this.http.request<HomeResponse>({
      method: "GET",
      path: "/home",
      query: opts.mode === "customer" ? { owner: "me" } : undefined,
    });
  }

  async tenantFull(tenantId: string): Promise<TenantFullResponse> {
    return this.http.request<TenantFullResponse>({
      method: "GET",
      path: `/tenants/${encodeURIComponent(tenantId)}/full`,
    });
  }
}
