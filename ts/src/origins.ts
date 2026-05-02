/**
 * Origins — ADR-049 §A.7.2 + ADR-047 §1.1.
 *
 * Partner backends call the unauthenticated proxy endpoints fronting
 * RealmID's platform-token-gated routes (e.g. `/auth/login`,
 * `/platforms/{id}/identity-providers`). Because RealmID no longer
 * inspects `Origin` on those routes, origin enforcement moves into the
 * SDK: this module fetches the per-realm origin allowlist and validates
 * a candidate `Origin` against it.
 *
 * Cache: in-memory, keyed by realmId, 5-minute TTL. On a 401 from the
 * underlying list call we invalidate the cached platform token, retry
 * once, then surface the error to the caller.
 */
import type { HttpClient } from "./http.js";
import { RealmError } from "./errors.js";
import { paginate, readPage, type Paginated, type PageOpts } from "./pagination.js";
import type { PlatformTokenManager } from "./platform-token-manager.js";

export interface Origin {
  id: string;
  domain: string;
  entity_type: "realm" | "tenant";
  entity_id: string;
  verification_id?: string | null;
  created_at?: string;
  detached_at?: string | null;
  [k: string]: unknown;
}

export interface OriginListOpts extends PageOpts {
  realmId: string;
}

export interface OriginValidateOpts {
  realmId: string;
  origin: string;
}

interface CacheEntry {
  allowlist: Set<string>;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Lowercase, strip scheme/port. Mirrors `domainmapping.Normalize` on
 * the Go side (ADR-049 §1.4).
 */
export function normalizeOrigin(raw: string): string {
  if (!raw) return "";
  let s = raw.trim().toLowerCase();
  if (s.startsWith("https://")) s = s.slice("https://".length);
  else if (s.startsWith("http://")) s = s.slice("http://".length);
  // strip path
  const slash = s.indexOf("/");
  if (slash >= 0) s = s.slice(0, slash);
  // strip port
  const colon = s.indexOf(":");
  if (colon >= 0) s = s.slice(0, colon);
  return s;
}

export class OriginsClient {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly http: HttpClient,
    private readonly platformTokens: PlatformTokenManager,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Paginated list of live origin mappings for the realm. Wraps
   * `GET /platforms/{realmId}/origins` (ADR-049 §A.7.2). Platform-token
   * auth is attached automatically.
   */
  list(opts: OriginListOpts): Paginated<Origin> {
    if (!opts.realmId) {
      throw new RealmError({ code: "bad_request", message: "origins.list: realmId required" });
    }
    const realmId = opts.realmId;
    return paginate<Origin>(async (po) => {
      const raw = await this.callList(realmId, po);
      return readPage<Origin>(raw);
    });
  }

  /**
   * Validate the supplied origin against the realm's allowlist. Reads
   * from cache; on cache miss or TTL expiry, refetches the full
   * allowlist. Returns true iff the normalized origin appears in any
   * live `domain_mappings` row for the realm (across both
   * `entity_type='realm'` and `entity_type='tenant'`).
   */
  async validate(opts: OriginValidateOpts): Promise<boolean> {
    if (!opts.realmId) {
      throw new RealmError({ code: "bad_request", message: "origins.validate: realmId required" });
    }
    const norm = normalizeOrigin(opts.origin);
    if (!norm) return false;
    const allowlist = await this.getAllowlist(opts.realmId);
    return allowlist.has(norm);
  }

  /** Drop the cached allowlist for one realm (or all when omitted). */
  invalidate(realmId?: string): void {
    if (realmId) this.cache.delete(realmId);
    else this.cache.clear();
  }

  private async getAllowlist(realmId: string): Promise<Set<string>> {
    const hit = this.cache.get(realmId);
    if (hit && this.now() - hit.fetchedAt < CACHE_TTL_MS) {
      return hit.allowlist;
    }
    const fresh = await this.fetchAllowlist(realmId);
    this.cache.set(realmId, { allowlist: fresh, fetchedAt: this.now() });
    return fresh;
  }

  private async fetchAllowlist(realmId: string): Promise<Set<string>> {
    const set = new Set<string>();
    let cursor: string | undefined;
    while (true) {
      const raw = await this.callList(realmId, cursor ? { cursor } : {});
      const page = readPage<Origin>(raw);
      for (const row of page.items) {
        if (row.detached_at) continue;
        const d = normalizeOrigin(row.domain);
        if (d) set.add(d);
      }
      if (!page.nextCursor) return set;
      cursor = page.nextCursor;
    }
  }

  /**
   * Underlying list HTTP call with refresh-on-401 semantics. On 401 we
   * force-mint a fresh platform token and retry once; if still 401,
   * the error propagates to the caller (matches ADR-047 §1.1).
   */
  private async callList(realmId: string, opts: PageOpts): Promise<unknown> {
    try {
      return await this.http.request<unknown>({
        method: "GET",
        path: `/platforms/${encodeURIComponent(realmId)}/origins`,
        query: { cursor: opts.cursor, limit: opts.limit },
      });
    } catch (e) {
      if (e instanceof RealmError && e.code === "unauthorized") {
        this.platformTokens.invalidate();
        return await this.http.request<unknown>({
          method: "GET",
          path: `/platforms/${encodeURIComponent(realmId)}/origins`,
          query: { cursor: opts.cursor, limit: opts.limit },
        });
      }
      throw e;
    }
  }
}
