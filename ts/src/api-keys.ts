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

/** Create payload (issuer `APIKey` create). `scope` is required. */
export interface ApiKeyCreate {
  /** The role/scope the key is bound to. Required. */
  scope: string;
  /** Optional human-readable label shown in listings. */
  label?: string;
}

/**
 * One API-key entry. A union of the create-response and list-row wire
 * shapes (issuer wins — see issuer swagger `APIKey` / `APIKeyListItem`):
 *
 *   - On create: `id`, `value` (the one-time secret), `scope`, `label`.
 *   - On list:   `id`, `prefix`, `role`, `created_at`, `last_used_at`,
 *                `revoked_at`.
 */
export interface ApiKey {
  id: string;
  /** Raw secret key — returned ONLY on create (one-time reveal). */
  value?: string;
  /** Echoed on create. */
  scope?: string;
  /** Optional human name supplied on create. */
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
   * List every API key for this realm. The issuer returns a paginated
   * `{ items, next_cursor, total }` envelope; we also accept a flat array
   * or a legacy `{ api_keys }` envelope for resilience (mirrors Go's
   * `decodeAPIKeyList`).
   */
  async list(): Promise<ApiKey[]> {
    const raw = await this.http.request<unknown>({
      method: "GET",
      path: `/platforms/${encodeURIComponent(this.realmId)}/api-keys`,
    });
    return decodeApiKeyList(raw);
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

/**
 * Tolerates the issuer `{ items }` envelope, a legacy `{ api_keys }`
 * envelope, or a flat array. Mirrors Go's `decodeAPIKeyList`.
 */
function decodeApiKeyList(raw: unknown): ApiKey[] {
  if (Array.isArray(raw)) return raw as ApiKey[];
  if (raw && typeof raw === "object") {
    const env = raw as { items?: ApiKey[]; api_keys?: ApiKey[] };
    if (Array.isArray(env.items)) return env.items;
    if (Array.isArray(env.api_keys)) return env.api_keys;
  }
  throw new RealmError({
    code: "server_error",
    message: "api-keys list: unexpected response shape",
  });
}
