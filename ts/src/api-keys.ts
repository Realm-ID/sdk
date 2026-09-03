/**
 * Realm API-key management — SPEC §6.5. Promoted to a top-level
 * namespace on the realm handle (`realm.apiKeys.*`).
 *
 * Wire shapes are issuer-authoritative ("code wins"): the create response
 * is the issuer `APIKey` (returns the one-time `value` secret), the list
 * rows are `APIKeyListItem`. The create request takes `scope` while the
 * list row reports `role` — the SDK surfaces both rather than papering
 * over the asymmetry (mirrors the Go SDK's `APIKey` struct). Field names
 * are snake_case on the wire, matching the rest of this SDK's DTOs.
 */

import type { HttpClient } from "./http.js";
import { RealmError } from "./errors.js";
import { paginate, readPage, type Paginated, type PageOpts } from "./pagination.js";

/** Create payload (issuer `APIKey` create). `scope` is required. */
export interface ApiKeyCreate {
  /** The role/scope the key is bound to. Required. */
  scope: string;
  /** Optional human-readable label shown in listings. */
  label?: string;
  /**
   * Requested lifetime (ADR-085 §3). Omitting this AND `non_expiring` applies
   * the issuer's built-in 90-day default. The floor is 300s and a smaller
   * value is REJECTED rather than clamped — clamping up would hand back a key
   * that outlives what was asked for.
   */
  ttl_seconds?: number;
  /**
   * Request a permanent key. A realm holds at most one non-expiring key and at
   * most 2 active platform keys in total (ADR-085 §2), so create can fail with
   * `non_expiring_not_allowed` (400) or `too_many_api_keys` (409).
   */
  non_expiring?: boolean;
}

/**
 * One API-key entry. A union of the create-response and list-row wire
 * shapes (issuer wins — see issuer swagger `APIKey` / `APIKeyListItem`):
 *
 *   - On create: `id`, `value` (the one-time secret), `scope`, `label`,
 *                `expires_at`.
 *   - On list:   `id`, `prefix`, `label`, `role`, `created_at`,
 *                `last_used_at`, `expires_at`, `revoked_at`.
 */
export interface ApiKey {
  id: string;
  /** Raw secret key — returned ONLY on create (one-time reveal). */
  value?: string;
  /** Echoed on create. */
  scope?: string;
  /**
   * The label supplied at create — echoed there and present on every list row
   * (issuer v0.61.0, ADR-085 §7). It is the ONLY handle on a key: the
   * plaintext is never echoed and `prefix` is derived from the stored hash, so
   * an `rk_live_…` found in a log cannot be traced to its row by value.
   */
  label?: string;
  /** Non-secret key prefix (list rows), stable across logs. */
  prefix?: string;
  /** The key's bound role as reported by the list endpoint (singular). */
  role?: string;
  /** Unix seconds (list rows). */
  created_at?: number;
  /** Unix seconds; null/absent until first use (list rows). */
  last_used_at?: number | null;
  /** Unix seconds; non-null means the key is revoked (list rows). */
  revoked_at?: number | null;
  /**
   * Unix seconds of the scheduled cutoff, or `null` for a non-expiring key
   * (ADR-085 §3). `null` is a VALUE, not an absence — "never expires" is a
   * fact the caller must be able to read. An expired key behaves exactly like
   * a revoked one at login and returns the same error envelope.
   */
  expires_at?: number | null;
}

export class ApiKeysClient {
  constructor(
    private readonly http: HttpClient,
    private readonly realmId: string,
  ) {}

  /**
   * Create a realm API key. Returns the row **plus** the one-time `value`
   * secret, which is shown only on creation and never returned by `list`.
   */
  async create(body: ApiKeyCreate): Promise<ApiKey> {
    return this.http.request<ApiKey>({
      method: "POST",
      path: `/platforms/${encodeURIComponent(this.realmId)}/api-keys`,
      body: {
        scope: body.scope,
        ...(body.label !== undefined ? { label: body.label } : {}),
      },
    });
  }

  /**
   * Paginate this realm's API keys.
   *
   * Returns the PAGER, not an array. The previous signature's own doc comment
   * already said the issuer answers a paginated
   * `{ items, next_cursor, total }` envelope — and then discarded it, so a
   * caller could neither page nor detect truncation. Read `.page().hasMore`,
   * or `for await` to walk everything.
   */
  list(opts?: PageOpts): Paginated<ApiKey> {
    const path = `/platforms/${encodeURIComponent(this.realmId)}/api-keys`;
    return paginate<ApiKey>(async (po) => {
      const raw = await this.http.request<unknown>({
        method: "GET",
        path,
        query: { cursor: po.cursor, limit: po.limit ?? opts?.limit },
      });
      return readPage<ApiKey>(raw);
    });
  }

  /** Soft-delete (sets `revoked_at`). */
  async revoke(id: string): Promise<void> {
    await this.http.request({
      method: "DELETE",
      path: `/platforms/${encodeURIComponent(this.realmId)}/api-keys/${encodeURIComponent(id)}`,
    });
  }
}

/**
 * Reports whether a key has been soft-deleted (`revoked_at` set).
 */
export function isApiKeyRevoked(k: ApiKey): boolean {
  return k.revoked_at != null;
}


