/**
 * Platform notes — append-only ops notes routed through the BFF's typed
 * `/admin/platforms/{id}/notes` surface (not `/platforms/...`). The path
 * matches `ui/web/src/api.ts:1158-1176`; the leading `/admin/` lives in
 * the BFF's typed routes so the shim auto-detects this as BFF-direct.
 */

import type { HttpLike } from "./transport.js";
import type { PlatformNote } from "./types.js";

export class PlatformNotesClient {
  constructor(private readonly http: HttpLike) {}

  async list(platformId: string): Promise<PlatformNote[]> {
    const d = await this.http.request<{ notes: PlatformNote[]; next_cursor: string | null }>({
      method: "GET",
      path: `/admin/platforms/${encodeURIComponent(platformId)}/notes`,
    });
    return d.notes;
  }

  async create(platformId: string, body: string): Promise<PlatformNote> {
    return this.http.request<PlatformNote>({
      method: "POST",
      path: `/admin/platforms/${encodeURIComponent(platformId)}/notes`,
      body: { body },
    });
  }
}
