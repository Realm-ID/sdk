/**
 * API-key lifecycle — `/platforms/{id}/api-keys` (SPEC §6.5).
 *
 * The bundled `ApiKeysClient` from `@realm-id/sdk/internal` predates the
 * issuer's current wire contract (it models `displayName` + `scopes[]`
 * and string timestamps). This package-local client targets the
 * authoritative issuer shapes — code wins, per `sdk/CLAUDE.md`:
 *
 *   - `create({ scope, label? })` → `APIKey` with a one-time `value`
 *     (the raw secret, shown only on creation).
 *   - `list()` → `APIKeyListItem[]` — rows report `role`/`prefix`/unix
 *     timestamps and carry **no** `label` (issuer asymmetry; see the
 *     issuer-side TODO, not ours to fix).
 *   - `revoke(id)` → soft-delete (sets `revoked_at`).
 *
 * Paths mirror the passthrough-routed `/platforms/*` surface, same as
 * `PlatformsClient`.
 */

import { paginate, readPage, type Paginated, type PageOpts } from "@realm-id/sdk";
import type { HttpLike } from "./transport.js";
import type {
  ApiKeyCreateInput,
  ApiKeyCreated,
  ApiKeyListItem,
  ApiKeyListPage,
} from "./types.js";

export class ApiKeysClient {
  constructor(private readonly http: HttpLike) {}

  /**
   * Create a key. Returns the row **plus** the one-time `value` (raw
   * secret) — surface it once to the user; it is never returned by
   * `list()`.
   */
  async create(
    platformId: string,
    input: ApiKeyCreateInput,
  ): Promise<ApiKeyCreated> {
    return this.http.request<ApiKeyCreated>({
      method: "POST",
      path: `/platforms/${encodeURIComponent(platformId)}/api-keys`,
      body: input,
    });
  }

  /**
   * Paginate a platform's keys (active + revoked). Revoked rows carry a
   * non-null `revoked_at`.
   *
   * Returns the PAGER, not an array. `/platforms/{id}/api-keys` is paginated
   * server-side, so an array could only ever be page one and the caller had no
   * way to tell it was cut short — a console showing 50 of 300 keys and no hint
   * that 250 exist is worse than one that says so. `for await` walks every
   * page; `.page({cursor, limit})` gives one page plus `hasMore`.
   */
  list(platformId: string, opts?: PageOpts): Paginated<ApiKeyListItem> {
    const path = `/platforms/${encodeURIComponent(platformId)}/api-keys`;
    return paginate<ApiKeyListItem>(async (po) => {
      const raw = await this.http.request<ApiKeyListPage>({
        method: "GET",
        path,
        query: { cursor: po.cursor, limit: po.limit ?? opts?.limit },
      });
      return readPage<ApiKeyListItem>(raw);
    });
  }

  /** Soft-delete (sets `revoked_at`); the row stays visible in `list()`. */
  async revoke(platformId: string, keyId: string): Promise<void> {
    await this.http.request<void>({
      method: "DELETE",
      path: `/platforms/${encodeURIComponent(platformId)}/api-keys/${encodeURIComponent(keyId)}`,
    });
  }
}
