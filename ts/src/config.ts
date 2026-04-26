/**
 * Realm-level config patch — SPEC §6.5. `realm.config.update(patch)`.
 * Subject to the server's configurable-keys allowlist.
 */

import type { HttpClient } from "./http.js";
import type { RealmInfo } from "./info.js";

export class ConfigClient {
  constructor(
    private readonly http: HttpClient,
    private readonly realmId: string,
  ) {}

  async update(patch: Record<string, unknown>): Promise<RealmInfo> {
    return this.http.request<RealmInfo>({
      method: "PATCH",
      path: `/realms/${encodeURIComponent(this.realmId)}/config`,
      body: patch,
    });
  }
}
