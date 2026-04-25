/**
 * Realm self — SPEC §6.6.
 *
 * `info()` — cached per-handle realm metadata (used internally for audience
 * auto-discovery). Source of truth: GET /platforms/mine when an API key is
 * available; falls back to POST /realms / GET /realms/{id} only if the server
 * exposes one (current API surface does not).
 *
 * `apiKeys.{create,list,revoke}` — manage realm API keys.
 */

import type { HttpClient } from "./http.js";

export interface RealmInfo {
  id: string;
  /** Canonical audience for this realm (its primary domain). */
  audience: string;
  display_name?: string;
  [k: string]: unknown;
}

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
      path: `/realms/${encodeURIComponent(this.realmId)}/api-keys`,
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
      path: `/realms/${encodeURIComponent(this.realmId)}/api-keys`,
    });
    if (Array.isArray(raw)) return raw;
    return raw.items ?? raw.api_keys ?? [];
  }

  async revoke(id: string): Promise<void> {
    await this.http.request({
      method: "DELETE",
      path: `/realms/${encodeURIComponent(this.realmId)}/api-keys/${encodeURIComponent(id)}`,
    });
  }
}

export class RealmSelfClient {
  readonly apiKeys: ApiKeysClient;
  private cachedInfo?: Promise<RealmInfo>;

  constructor(
    private readonly http: HttpClient,
    private readonly realmId: string,
    private readonly hasApiKey: boolean,
  ) {
    this.apiKeys = new ApiKeysClient(http, realmId);
  }

  /** Cached for the lifetime of the handle (SPEC §1 audience auto-discovery). */
  info(): Promise<RealmInfo> {
    if (!this.cachedInfo) {
      this.cachedInfo = this.fetchInfo().catch((e) => {
        // Don't poison the cache on failure; allow next call to retry.
        this.cachedInfo = undefined;
        throw e;
      });
    }
    return this.cachedInfo;
  }

  async updateConfig(patch: Record<string, unknown>): Promise<RealmInfo> {
    return this.http.request<RealmInfo>({
      method: "PATCH",
      path: `/realms/${encodeURIComponent(this.realmId)}/config`,
      body: patch,
    });
  }

  /** Force a refresh of cached info on next call. */
  invalidateInfo(): void {
    this.cachedInfo = undefined;
  }

  private async fetchInfo(): Promise<RealmInfo> {
    if (this.hasApiKey) {
      // GET /platforms/mine returns the platforms (and embedded realms) the
      // caller's API key belongs to. We pick the realm that matches our id.
      try {
        const raw = await this.http.request<unknown>({
          method: "GET",
          path: "/platforms/mine",
        });
        const found = findRealmIn(raw, this.realmId);
        if (found) return found;
      } catch {
        // fall through to JWKS probe
      }
    }
    // Last-resort: JWKS endpoint exists for every realm but doesn't carry
    // audience metadata. Return a stub so callers calling realm.info()
    // without an API key still get the realm id back.
    return { id: this.realmId, audience: "" };
  }
}

function findRealmIn(raw: unknown, realmId: string): RealmInfo | undefined {
  const visit = (node: unknown): RealmInfo | undefined => {
    if (!node || typeof node !== "object") return undefined;
    if (Array.isArray(node)) {
      for (const x of node) {
        const r = visit(x);
        if (r) return r;
      }
      return undefined;
    }
    const obj = node as Record<string, unknown>;
    if (obj["id"] === realmId && (typeof obj["audience"] === "string" || typeof obj["domain"] === "string")) {
      const aud = (obj["audience"] ?? obj["domain"]) as string;
      return { ...(obj as RealmInfo), audience: aud };
    }
    for (const v of Object.values(obj)) {
      const r = visit(v);
      if (r) return r;
    }
    return undefined;
  };
  return visit(raw);
}

function omit<T extends Record<string, unknown>>(obj: T, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!keys.includes(k) && v !== undefined) out[k] = v;
  }
  return out;
}
