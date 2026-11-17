/**
 * Realm self-metadata — SPEC §6.5.
 *
 * Today this walks `GET /platforms/mine` (the only endpoint that returns
 * realm metadata for the calling API key) and picks the realm matching
 * the configured `realmId`. When the server eventually adds a dedicated
 * `GET /realm` self-endpoint, swap the implementation here without
 * touching callers.
 *
 * A SUCCESSFUL result is cached per-handle for the lifetime of the realm
 * handle — the audience auto-discovery path (verifier + auth Origin) reads
 * it once and reuses. A FAILED discovery is never cached: the call that hit
 * it gets the empty stub (so it fails open), and a later call retries, at
 * most once per RETRY_MS so an outage does not hammer the issuer.
 */

import type { HttpClient } from "./http.js";

const RETRY_MS = 30_000;

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
  private lastFailureMs?: number;

  constructor(
    private readonly http: HttpClient,
    private readonly realmId: string,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  /** A success is cached for the lifetime of the handle; a failure is retried after RETRY_MS. */
  get(): Promise<RealmInfo> {
    if (this.cached) return this.cached;
    if (this.lastFailureMs !== undefined && this.nowMs() - this.lastFailureMs < RETRY_MS) {
      return Promise.resolve(this.stub());
    }
    const attempt: Promise<RealmInfo> = this.fetchInfo().then((found) => {
      if (found) return found;
      this.lastFailureMs = this.nowMs();
      if (this.cached === attempt) this.cached = undefined;
      return this.stub();
    });
    this.cached = attempt;
    return attempt;
  }

  invalidate(): void {
    this.cached = undefined;
    this.lastFailureMs = undefined;
  }

  private stub(): RealmInfo {
    return { id: this.realmId, audience: "" };
  }

  private async fetchInfo(): Promise<RealmInfo | undefined> {
    try {
      const raw = await this.http.request<unknown>({
        method: "GET",
        path: "/platforms/mine",
      });
      return findRealmIn(raw, this.realmId);
    } catch {
      return undefined;
    }
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
