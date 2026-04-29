/**
 * Realm API-key management — SPEC §6.5. Promoted to a top-level
 * namespace on the realm handle (`realm.apiKeys.*`).
 */

import type { HttpClient } from "./http.js";

export interface ApiKeyCreate {
  displayName: string;
  scopes?: string[];
  [k: string]: unknown;
}

export interface ApiKey {
  id: string;
  display_name?: string;
  prefix?: string;
  /** Only present on creation. */
  secret?: string;
  scopes?: string[];
  created_at?: string;
  revoked_at?: string;
  [k: string]: unknown;
}

export class ApiKeysClient {
  constructor(
    private readonly http: HttpClient,
    private readonly realmId: string,
  ) {}

  async create(body: ApiKeyCreate): Promise<ApiKey> {
    return this.http.request<ApiKey>({
      method: "POST",
      path: `/platforms/${encodeURIComponent(this.realmId)}/api-keys`,
      body: {
        display_name: body.displayName,
        scopes: body.scopes,
        ...omit(body, ["displayName", "scopes"]),
      },
    });
  }

  async list(): Promise<ApiKey[]> {
    const raw = await this.http.request<{ items?: ApiKey[]; api_keys?: ApiKey[] } | ApiKey[]>({
      method: "GET",
      path: `/platforms/${encodeURIComponent(this.realmId)}/api-keys`,
    });
    if (Array.isArray(raw)) return raw;
    return raw.items ?? raw.api_keys ?? [];
  }

  async revoke(id: string): Promise<void> {
    await this.http.request({
      method: "DELETE",
      path: `/platforms/${encodeURIComponent(this.realmId)}/api-keys/${encodeURIComponent(id)}`,
    });
  }
}

function omit<T extends Record<string, unknown>>(obj: T, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!keys.includes(k) && v !== undefined) out[k] = v;
  }
  return out;
}
