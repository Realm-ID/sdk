/**
 * Realm self-metadata — SPEC §6.5.
 *
 * Today this walks `GET /platforms/mine` (the only endpoint that returns
 * realm metadata for the calling API key) and picks the realm matching
 * the configured `realmId`. When the server eventually adds a dedicated
 * `GET /realm` self-endpoint, swap the implementation here without
 * touching callers.
 *
 * The result is cached per-handle for the lifetime of the realm handle —
 * the audience auto-discovery path (verifier + auth Origin) reads it
 * once and reuses. Failures don't poison the cache.
 */

import type { HttpClient } from "./http.js";

export interface RealmInfo {
  id: string;
  /** Canonical audience for this realm (its primary domain). */
  audience: string;
  /** Alias of audience; some server payloads name it `domain`. */
  domain?: string;
  display_name?: string;
  [k: string]: unknown;
}

export class InfoClient {
  private cached?: Promise<RealmInfo>;

  constructor(
    private readonly http: HttpClient,
    private readonly realmId: string,
  ) {}

  /** Cached for the lifetime of the handle. */
  get(): Promise<RealmInfo> {
    if (!this.cached) {
      this.cached = this.fetchInfo().catch((e) => {
        // Don't poison the cache on failure; allow next call to retry.
        this.cached = undefined;
        throw e;
      });
    }
    return this.cached;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private async fetchInfo(): Promise<RealmInfo> {
    try {
      const raw = await this.http.request<unknown>({
        method: "GET",
        path: "/platforms/mine",
      });
      const found = findRealmIn(raw, this.realmId);
      if (found) return found;
    } catch {
      // fall through to stub
    }
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
    if (
      obj["id"] === realmId &&
      (typeof obj["audience"] === "string" || typeof obj["domain"] === "string")
    ) {
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
