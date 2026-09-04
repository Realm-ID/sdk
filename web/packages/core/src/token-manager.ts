import { RealmError } from "./errors.js";
import type { Transport } from "./transport.js";
import type { GateRule, RefreshConfig, RequestAdapters, ResponseAdapters, TokenResponse } from "./types.js";
import { resolveExpiresIn } from "./util.js";

interface TokenEntry {
  accessToken: string;
  expiresAt: number; // ms epoch
}

/**
 * Holds in-memory access tokens (keyed by tenantId, plus a "current" pointer)
 * and dedupes refresh-on-401 + proactive refresh into a single in-flight
 * Promise per tenant.
 *
 * Refresh fires `POST /token` against the BFF. Two BFF flavours are
 * supported:
 *
 *   - Token-rotating (default): /token returns `{ accessToken, expiresIn }`
 *     and the SDK swaps the in-memory bearer.
 *   - Tokenless rotation (`refresh.tokenless`): /token returns only
 *     `{ expiresAt }`; the bearer is opaque (e.g. an HttpOnly cookie or a
 *     server-side session id) and the SDK keeps using the previous one,
 *     just advancing its expiry.
 */
export class TokenManager {
  private tokens = new Map<string, TokenEntry>();
  private inflight = new Map<string, Promise<string>>();
  private currentTenantId: string | null = null;
  /**
   * Per tenant, the access token the LAST forced (token_stale) refresh
   * produced — ADR-107 D13's whole bookkeeping. A `token_stale` on that exact
   * token means the refresh already happened and did not help, so refreshing
   * again would be the loop C5 warns about. One string per tenant, not a set:
   * the cap is per token, and the only token that can be "already refreshed
   * for" is the one we just minted.
   */
  private forcedByTenant = new Map<string, string>();

  constructor(
    private transport: Transport,
    private opts: {
      refreshSkewMs: number;
      onRefreshed: () => void;
      onLost: (reason: string) => void;
      adapters: ResponseAdapters;
      requestAdapters: RequestAdapters;
      gates: GateRule[];
      refresh: RefreshConfig;
    },
  ) {}

  setCurrentTenant(tenantId: string | null): void {
    this.currentTenantId = tenantId;
  }

  getCurrentTenant(): string | null {
    return this.currentTenantId;
  }

  /** True when `accessToken` was itself minted by a forced refresh (ADR-107 D13). */
  wasForcedFor(tenantId: string, accessToken: string): boolean {
    return accessToken !== "" && this.forcedByTenant.get(tenantId) === accessToken;
  }

  /** Records the token a forced refresh produced, so the next `token_stale` on it hard-fails. */
  markForced(tenantId: string, accessToken: string): void {
    if (accessToken) this.forcedByTenant.set(tenantId, accessToken);
  }

  /** Stash a token for a tenant. `expiresInSec` accepts either an `expiresIn` or a derived value from `expiresAt`. */
  set(tenantId: string, accessToken: string, expiresInSec: number): void {
    this.tokens.set(tenantId, {
      accessToken,
      expiresAt: Date.now() + expiresInSec * 1000,
    });
  }

  /** Peek the current bearer without triggering a refresh. */
  peek(tenantId?: string): string | undefined {
    const tid = tenantId ?? this.currentTenantId;
    if (!tid) return undefined;
    return this.tokens.get(tid)?.accessToken;
  }

  /** Peek the absolute expiry (ms epoch) for `tenantId` without triggering a refresh. */
  peekExpiresAt(tenantId?: string): number | undefined {
    const tid = tenantId ?? this.currentTenantId;
    if (!tid) return undefined;
    return this.tokens.get(tid)?.expiresAt;
  }

  clear(): void {
    this.tokens.clear();
    this.inflight.clear();
    this.currentTenantId = null;
  }

  async get(tenantId?: string): Promise<string> {
    const tid = tenantId ?? this.currentTenantId;
    if (!tid) throw new RealmError("unauthorized", "no current tenant");

    const entry = this.tokens.get(tid);
    if (entry && entry.expiresAt - this.opts.refreshSkewMs > Date.now()) {
      return entry.accessToken;
    }
    return this.refresh(tid);
  }

  async refresh(tenantId?: string): Promise<string> {
    const tid = tenantId ?? this.currentTenantId;
    if (!tid) throw new RealmError("unauthorized", "no current tenant");

    const existing = this.inflight.get(tid);
    if (existing) return existing;

    const p = this.doRefresh(tid).finally(() => {
      this.inflight.delete(tid);
    });
    this.inflight.set(tid, p);
    return p;
  }

  private async doRefresh(tenantId: string): Promise<string> {
    const current = this.tokens.get(tenantId);
    try {
      const wireBody = this.opts.requestAdapters.token
        ? this.opts.requestAdapters.token({ tenantId })
        : { tenantId };
      const res = await this.transport.request<unknown>("POST", this.transport.endpoints.token, {
        body: wireBody,
        accessToken: this.opts.refresh.sendBearer ? current?.accessToken : undefined,
        gates: this.opts.gates,
      });
      const adapted: TokenResponse = this.opts.adapters.token
        ? this.opts.adapters.token(res.body, {
            status: res.status,
            headers: res.headers,
            currentAccessToken: current?.accessToken,
          })
        : (res.body as TokenResponse);

      const expiresIn = resolveExpiresIn(adapted.expiresIn, adapted.expiresAt);
      if (expiresIn === undefined) {
        throw new RealmError("server_error", "/token response missing expiresIn/expiresAt", res.status, adapted);
      }

      let nextToken: string | undefined = adapted.accessToken;
      if (!nextToken) {
        if (this.opts.refresh.tokenless && current?.accessToken) {
          nextToken = current.accessToken;
        } else if (this.opts.refresh.tokenless) {
          // Tokenless mode but no prior bearer (e.g. cookie-only) — use empty
          // string to mark "session is alive but bearer not surfaced". Realm.fetch
          // skips Authorization in that case.
          nextToken = "";
        } else {
          throw new RealmError("server_error", "/token response missing accessToken", res.status, adapted);
        }
      }

      this.set(tenantId, nextToken, expiresIn);
      this.opts.onRefreshed();
      return nextToken;
    } catch (err) {
      if (err instanceof RealmError) {
        if (
          err.code === "session_expired" ||
          err.code === "session_replaced" ||
          err.code === "session_revoked" ||
          err.code === "unauthorized"
        ) {
          this.tokens.delete(tenantId);
          const reason =
            err.code === "session_replaced"
              ? "replaced"
              : err.code === "session_revoked"
                ? "revoked"
                : "expired";
          this.opts.onLost(reason);
        }
      }
      throw err;
    }
  }
}
