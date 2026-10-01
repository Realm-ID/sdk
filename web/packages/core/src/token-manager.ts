import { RealmError } from "./errors.js";
import type { TabBus, TabMessage } from "./multi-tab.js";
import type { Transport } from "./transport.js";
import type { GateRule, RefreshConfig, RequestAdapters, ResponseAdapters, TokenResponse } from "./types.js";
import { resolveExpiresIn } from "./util.js";

interface TokenEntry {
  accessToken: string;
  expiresAt: number; // ms epoch
}

/** BFF-SPEC v0.63.0: a sibling's result is only worth adopting inside the lock for this long. */
const SIBLING_RESULT_WINDOW_MS = 5_000;

export type OrgSessionMode = "concurrent" | "exclusive";

/** `org_session_mode` off a success body; anything unrecognised is `concurrent`, absent is undefined. */
export function readOrgSessionMode(raw: unknown): OrgSessionMode | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const b = raw as Record<string, unknown>;
  const v = b.org_session_mode ?? b.orgSessionMode;
  if (v === undefined) return undefined;
  return v === "exclusive" ? "exclusive" : "concurrent";
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
  /** Org-session mode last reported by the BFF (SPEC §6.7.3). Absent → concurrent. */
  private orgMode: OrgSessionMode = "concurrent";
  /** Per tenant, the last sibling-tab result adopted: when, and the expiry it carried. */
  private sibling = new Map<string, { at: number; expiresAt: number }>();
  /** Tail of the in-tab queue used when `navigator.locks` is absent (per BFF, not per tenant). */
  private chain: Promise<unknown> = Promise.resolve();

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
      /** The tab bus; carries refresh results between tabs (BFF-SPEC v0.63.0). */
      bus?: TabBus;
      /** The bus channel name — one per BFF base URL; names the Web Lock. */
      channelName?: string;
    },
  ) {
    opts.bus?.subscribe((msg) => this.onTabMessage(msg));
  }

  setOrgSessionMode(mode: OrgSessionMode): void {
    this.orgMode = mode;
  }

  private onTabMessage(msg: TabMessage): void {
    if (msg.type === "token_refreshed") {
      const { tenantId, accessToken, expiresAt } = msg;
      if (!tenantId || typeof expiresAt !== "number") return;
      const held = this.tokens.get(tenantId);
      if (accessToken !== undefined) {
        if (held && expiresAt <= held.expiresAt) return;
        this.tokens.set(tenantId, { accessToken, expiresAt });
      } else {
        // Tokenless: only the expiry of the bearer already held advances. A
        // token-bearing BFF whose message lost its token (storage fallback)
        // must NOT advance it — nothing was minted for THIS tab's bearer.
        if (!this.opts.refresh.tokenless || !held || expiresAt <= held.expiresAt) return;
        held.expiresAt = expiresAt;
      }
      this.sibling.set(tenantId, { at: Date.now(), expiresAt });
    } else if (msg.type === "tenant_switched" && this.orgMode === "exclusive") {
      this.dropOthers(msg.tenantId);
    }
  }

  private dropOthers(keep: string): void {
    for (const k of [...this.tokens.keys()]) {
      if (k !== keep) {
        this.tokens.delete(k);
        this.forcedByTenant.delete(k);
      }
    }
  }

  /** One refresh across tabs: a Web Lock per BFF, else an in-tab queue per BFF. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const locks = (globalThis as { navigator?: { locks?: { request?: unknown } } }).navigator?.locks;
    if (locks && typeof locks.request === "function") {
      return (locks as unknown as LockManager).request(
        `realmid-refresh:${this.opts.channelName ?? ""}`,
        { mode: "exclusive" },
        fn,
      ) as Promise<T>;
    }
    const run = this.chain.catch(() => {}).then(fn);
    this.chain = run;
    return run;
  }

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

    const heldExpiry = this.tokens.get(tid)?.expiresAt ?? 0;
    const p = this.exclusive(() => this.doRefresh(tid, heldExpiry)).finally(() => {
      this.inflight.delete(tid);
    });
    this.inflight.set(tid, p);
    return p;
  }

  private async doRefresh(tenantId: string, heldExpiryAtRequest: number): Promise<string> {
    // Inside the lock: a sibling tab may have minted for this tenant while we
    // waited. Adopt it (it is already in `tokens`) rather than spend a second
    // rotation — but only a RECENT one that is newer than what we held.
    const sib = this.sibling.get(tenantId);
    if (sib && Date.now() - sib.at <= SIBLING_RESULT_WINDOW_MS && sib.expiresAt > heldExpiryAtRequest) {
      const adopted = this.tokens.get(tenantId);
      if (adopted) return adopted.accessToken;
    }
    const current = this.tokens.get(tenantId);
    try {
      const wireBody = this.opts.requestAdapters.token
        ? this.opts.requestAdapters.token({ tenantId })
        : { tenantId };
      const send = (body: unknown) =>
        this.transport.request<unknown>("POST", this.transport.endpoints.token, {
          body,
          accessToken: this.opts.refresh.sendBearer ? current?.accessToken : undefined,
          gates: this.opts.gates,
        });
      let res;
      try {
        res = await send(wireBody);
      } catch (err) {
        // `503 retry:true` is a superseded refresh, not a lost session: adopt
        // the rotated refresh token it carries (body mode; cookie mode needs
        // nothing) and retry ONCE inside this same lock. A second 503 throws.
        const rb =
          err instanceof RealmError && err.status === 503
            ? (err.body as Record<string, unknown> | undefined)
            : undefined;
        if (!rb || rb.retry !== true) throw err;
        const rt = rb.refresh_token ?? rb.refreshToken;
        // Set BOTH spellings: the SDK middleware reads `refresh_token` first, so an
        // adapter-built snake_case body would otherwise re-present the spent token.
        res = await send(
          typeof rt === "string" ? { ...(wireBody as object), refresh_token: rt, refreshToken: rt } : wireBody,
        );
      }
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
      this.orgMode = readOrgSessionMode(res.body) ?? readOrgSessionMode(adapted) ?? "concurrent";
      const expiresAt = this.tokens.get(tenantId)!.expiresAt;
      this.opts.bus?.post({
        type: "token_refreshed",
        tenantId,
        // Tokenless: the bearer is opaque and unchanged — share the expiry only.
        ...(this.opts.refresh.tokenless ? {} : { accessToken: nextToken }),
        expiresAt,
      });
      if (this.orgMode === "exclusive") {
        // One org at a time: every other org's token is already refused
        // server-side. Tell the other tabs to follow rather than refresh theirs.
        this.dropOthers(tenantId);
        this.opts.bus?.post({ type: "tenant_switched", tenantId });
      }
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
