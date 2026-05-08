import { RealmError } from "./errors.js";
import type { Transport } from "./transport.js";
import type { TokenResponse } from "./types.js";

interface TokenEntry {
  accessToken: string;
  expiresAt: number; // ms epoch
}

/**
 * Holds in-memory access tokens (keyed by tenantId, plus a "current" pointer)
 * and dedupes refresh-on-401 + proactive refresh into a single in-flight
 * Promise per tenant. Refresh fires `POST /token` against the BFF; the
 * refresh credential lives in an httpOnly cookie set by the BFF, so the SDK
 * never sees it.
 */
export class TokenManager {
  private tokens = new Map<string, TokenEntry>();
  private inflight = new Map<string, Promise<string>>();
  private currentTenantId: string | null = null;

  constructor(
    private transport: Transport,
    private opts: { refreshSkewMs: number; onRefreshed: () => void; onLost: (reason: string) => void },
  ) {}

  setCurrentTenant(tenantId: string | null): void {
    this.currentTenantId = tenantId;
  }

  getCurrentTenant(): string | null {
    return this.currentTenantId;
  }

  set(tenantId: string, accessToken: string, expiresInSec: number): void {
    this.tokens.set(tenantId, {
      accessToken,
      expiresAt: Date.now() + expiresInSec * 1000,
    });
  }

  clear(): void {
    this.tokens.clear();
    this.inflight.clear();
    this.currentTenantId = null;
  }

  /**
   * Returns a non-expired access token for the given tenant (or current).
   * Triggers a refresh if missing or within `refreshSkewMs` of expiry.
   * Concurrent callers share one in-flight refresh.
   */
  async get(tenantId?: string): Promise<string> {
    const tid = tenantId ?? this.currentTenantId;
    if (!tid) throw new RealmError("unauthorized", "no current tenant");

    const entry = this.tokens.get(tid);
    if (entry && entry.expiresAt - this.opts.refreshSkewMs > Date.now()) {
      return entry.accessToken;
    }
    return this.refresh(tid);
  }

  /** Force a refresh for the given tenant (used on 401 replay). */
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
    try {
      const { body } = await this.transport.request<TokenResponse>(
        "POST",
        this.transport.endpoints.token,
        { body: { tenantId } },
      );
      this.set(tenantId, body.accessToken, body.expiresIn);
      this.opts.onRefreshed();
      return body.accessToken;
    } catch (err) {
      if (err instanceof RealmError && (err.code === "session_expired" || err.code === "session_replaced" || err.code === "unauthorized")) {
        this.tokens.delete(tenantId);
        this.opts.onLost(err.code === "session_replaced" ? "replaced" : "expired");
      }
      throw err;
    }
  }
}
