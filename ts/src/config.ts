/**
 * Realm-level config — SPEC §6.5. `realm.config.get()` /
 * `realm.config.update(patch)`. Subject to the server's configurable-keys
 * allowlist; the read and the write share the same authorization (the
 * ADR-074 `platform:config` permission, or realm owner).
 */

import type { HttpClient } from "./http.js";
import type { RealmInfo } from "./info.js";

/**
 * The realm's configuration as served by `GET /platforms/{id}/config`.
 *
 * Deliberately a loose record, mirroring the untyped patch on the write
 * side: the key set is server-owned (the issuer derives it by reflection
 * from its `RealmConfigPatch` and drift-tests it there), so a hand-maintained
 * interface here would go stale the moment a key is added and would silently
 * mislead. Narrow a key at the call site.
 *
 * Server conventions (issuer `realm.ConfigView`):
 * - every allowlist key is ALWAYS present; the zero value means "unset"
 *   (`0` for numbers, `""` for strings, `false` for booleans),
 * - `access_token_custom_claim_keys` is always an array, never null,
 * - `refresh_absolute_expiry` is always the full object
 *   `{mode ("rolling" when unset), daily_cutoff_local, timezone,
 *   applies_to_service}`.
 */
export type RealmConfigValues = Record<string, unknown>;

/** GET /platforms/{id}/config body: the realm id plus its config. */
export interface RealmConfigResponse {
  id: string;
  config: RealmConfigValues;
}

export class ConfigClient {
  constructor(
    private readonly http: HttpClient,
    private readonly realmId: string,
  ) {}

  /** GET /platforms/{id}/config — read counterpart of `update()`. */
  async get(): Promise<RealmConfigResponse> {
    const raw = await this.http.request<RealmConfigResponse>({
      method: "GET",
      path: `/platforms/${encodeURIComponent(this.realmId)}/config`,
    });
    return { id: raw?.id ?? this.realmId, config: raw?.config ?? {} };
  }

  async update(patch: Record<string, unknown>): Promise<RealmInfo> {
    return this.http.request<RealmInfo>({
      method: "PATCH",
      path: `/platforms/${encodeURIComponent(this.realmId)}/config`,
      body: patch,
    });
  }
}
