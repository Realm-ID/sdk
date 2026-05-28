/**
 * API-key lifecycle — `/platforms/{id}/api-keys` (SPEC §6.5).
 *
 * The bundled `ApiKeysClient` from `@realmid/sdk/internal` predates the
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

  /** List keys (active + revoked). Revoked rows carry a non-null `revoked_at`. */
  async list(platformId: string): Promise<ApiKeyListItem[]> {
    const page = await this.http.request<ApiKeyListPage>({
      method: "GET",
      path: `/platforms/${encodeURIComponent(platformId)}/api-keys`,
    });
    return page.items ?? [];
  }

  /** Soft-delete (sets `revoked_at`); the row stays visible in `list()`. */
  async revoke(platformId: string, keyId: string): Promise<void> {
    await this.http.request<void>({
      method: "DELETE",
      path: `/platforms/${encodeURIComponent(platformId)}/api-keys/${encodeURIComponent(keyId)}`,
    });
  }
}
