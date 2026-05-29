/**
 * Platform notes — append-only ops notes on the **issuer**'s
 * `/admin/platforms/{id}/notes` surface (`issuer/internal/httpapi/routes.go:155-156`),
 * reached via the BFF `/api` passthrough. The leading `/admin/` is an
 * issuer route, NOT a BFF typed route, so the transport shim routes it
 * through `/api` (it is intentionally absent from `BFF_DIRECT_PREFIXES`).
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
