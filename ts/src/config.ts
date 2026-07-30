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
  /**
   * ADR-092 D4 — how many people in this realm still hold 2+ ACTIVE
   * memberships while `single_tenant_membership` is on. It sits BESIDE
   * `config`, not inside it, precisely because it is DERIVED, read-only state;
   * putting it in the settings bag would imply it is settable, and PATCHing it
   * answers `400 unknown_config_key`.
   *
   * `undefined` means the rule is off (the issuer reports the number only
   * while it is on); `0` means on and fully drained. Turning the rule on is
   * allowed with violations outstanding — the D5 picker drains them at each
   * next login, so a user who never logs in never resolves and this number is
   * how an admin sees that.
   */
  singleTenantPendingReconciliation?: number;
}

/** Raw GET /platforms/{id}/config wire body. */
interface RawRealmConfigResponse {
  id?: string;
  config?: RealmConfigValues;
  single_tenant_pending_reconciliation?: number;
}

export class ConfigClient {
  constructor(
    private readonly http: HttpClient,
    private readonly realmId: string,
  ) {}

  /** GET /platforms/{id}/config — read counterpart of `update()`. */
  async get(): Promise<RealmConfigResponse> {
    const raw = await this.http.request<RawRealmConfigResponse>({
      method: "GET",
      path: `/platforms/${encodeURIComponent(this.realmId)}/config`,
    });
    return {
      id: raw?.id ?? this.realmId,
      config: raw?.config ?? {},
      singleTenantPendingReconciliation: raw?.single_tenant_pending_reconciliation,
    };
  }

  async update(patch: Record<string, unknown>): Promise<RealmInfo> {
    return this.http.request<RealmInfo>({
      method: "PATCH",
      path: `/platforms/${encodeURIComponent(this.realmId)}/config`,
      body: patch,
    });
  }
}
