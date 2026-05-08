import { RealmError } from "./errors.js";
import { Observable } from "./observable.js";
import { Transport } from "./transport.js";
import { TokenManager } from "./token-manager.js";
import { createTabBus, type TabBus } from "./multi-tab.js";
import type {
  AuthEvent,
  AuthState,
  LoginRequest,
  LoginResponse,
  MeResponse,
  ProvidersResponse,
  RealmConfig,
  TenantRef,
  UserSummary,
} from "./types.js";

export interface FetchOptions extends RequestInit {
  /** Per-call tenant override; defaults to the realm's current tenant. */
  tenantId?: string;
  /** Skip auto-attach (useful for explicitly anonymous calls). */
  anonymous?: boolean;
}

export class Realm {
  private transport: Transport;
  private tokens: TokenManager;
  private events = new Observable<AuthEvent>();
  private bus: TabBus;
  private state: AuthState = {
    status: "loading",
    user: null,
    tenants: [],
    currentTenantId: null,
  };
  private mfaPendingChallenge: { challengeId: string; method: string } | null = null;
  private restorePromise: Promise<void> | null = null;

  constructor(cfg: RealmConfig) {
    this.transport = new Transport(cfg);
    const skew = cfg.refreshSkewMs ?? 60_000;
    this.tokens = new TokenManager(this.transport, {
      refreshSkewMs: skew,
      onRefreshed: () => {
        this.events.emit({ type: "token_refreshed" });
        this.bus.post({ type: "token_refreshed" });
      },
      onLost: (reason) => {
        this.handleSessionLost(reason as "expired" | "replaced");
      },
    });

    const channel = cfg.channelName ?? `realmid:${this.transport.baseUrl}`;
    this.bus = createTabBus(channel);
    this.bus.subscribe((msg) => this.onTabMessage(msg));

    if (cfg.autoRestore !== false) {
      this.restorePromise = this.restore().catch(() => {
        /* restore swallows — initial /me 401 is normal anonymous state */
      });
    } else {
      this.setState({ ...this.state, status: "anonymous" });
    }
  }

  /* -------------------------------------------------- state + events */

  getState(): AuthState {
    return this.state;
  }

  onAuthChange(listener: (ev: AuthEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  /** Resolves once the initial restore probe has settled. */
  ready(): Promise<void> {
    return this.restorePromise ?? Promise.resolve();
  }

  /* -------------------------------------------------- discovery */

  async providers(opts: { tenantId?: string; clientType?: string } = {}): Promise<ProvidersResponse> {
    const qs = new URLSearchParams();
    if (opts.tenantId) qs.set("tenant_id", opts.tenantId);
    if (opts.clientType) qs.set("client_type", opts.clientType);
    const path = this.transport.endpoints.providers + (qs.size ? `?${qs}` : "");
    const { body } = await this.transport.request<ProvidersResponse>("GET", path);
    return body;
  }

  /* -------------------------------------------------- session */

  async restore(): Promise<void> {
    try {
      const { body } = await this.transport.request<MeResponse>("GET", this.transport.endpoints.me);
      this.applyMe(body);
    } catch (err) {
      // 401 = anonymous, anything else propagates as a soft anonymous start.
      this.setState({
        status: "anonymous",
        user: null,
        tenants: [],
        currentTenantId: null,
      });
      this.events.emit({ type: "ready", user: null, tenants: [], currentTenantId: null });
      if (err instanceof RealmError && err.code === "network_error") throw err;
    }
  }

  async login(req: LoginRequest): Promise<LoginResponse> {
    const { body } = await this.transport.request<LoginResponse>(
      "POST",
      this.transport.endpoints.login,
      { body: req },
    );
    if (body.mfa) {
      this.mfaPendingChallenge = body.mfa;
      throw new RealmError("mfa_required", "mfa challenge pending", 0, body);
    }
    this.applyLoginResponse(body);
    this.bus.post({ type: "login" });
    return body;
  }

  async logout(): Promise<void> {
    try {
      await this.transport.request("POST", this.transport.endpoints.logout, { body: {} });
    } catch (err) {
      if (!(err instanceof RealmError) || (err.status !== 401 && err.status !== 404)) throw err;
    }
    this.tokens.clear();
    this.setState({ status: "anonymous", user: null, tenants: [], currentTenantId: null });
    this.events.emit({ type: "logout", reason: "user" });
    this.bus.post({ type: "logout", reason: "user" });
  }

  async switchTenant(tenantId: string): Promise<void> {
    if (!this.state.tenants.find((t) => t.id === tenantId)) {
      throw new RealmError("tenant_not_found", `tenant ${tenantId} not in current session`);
    }
    const { body } = await this.transport.request<{ accessToken: string; expiresIn: number }>(
      "POST",
      this.transport.endpoints.switchTenant,
      { body: { tenantId } },
    );
    this.tokens.set(tenantId, body.accessToken, body.expiresIn);
    this.tokens.setCurrentTenant(tenantId);
    this.setState({ ...this.state, currentTenantId: tenantId });
    this.events.emit({ type: "tenant_switched", currentTenantId: tenantId });
    this.bus.post({ type: "tenant_switched", tenantId });
  }

  /* -------------------------------------------------- mfa */

  readonly mfa = {
    pending: (): { challengeId: string; method: string } | null => this.mfaPendingChallenge,
    challenge: async (req: { method: string; destination?: string }): Promise<{ challengeId: string }> => {
      const { body } = await this.transport.request<{ challengeId: string }>(
        "POST",
        this.transport.endpoints.mfaChallenge,
        { body: req },
      );
      this.mfaPendingChallenge = { challengeId: body.challengeId, method: req.method };
      return body;
    },
    verify: async (code: string): Promise<LoginResponse> => {
      if (!this.mfaPendingChallenge) throw new RealmError("mfa_failed", "no challenge pending");
      const { body } = await this.transport.request<LoginResponse>(
        "POST",
        this.transport.endpoints.mfaVerify,
        { body: { challengeId: this.mfaPendingChallenge.challengeId, code } },
      );
      this.mfaPendingChallenge = null;
      this.applyLoginResponse(body);
      this.bus.post({ type: "login" });
      return body;
    },
  };

  /* -------------------------------------------------- fetch */

  /**
   * Authenticated fetch wrapper. Auto-attaches Authorization, dedupes
   * refresh-on-401, and replays the original request once on success.
   */
  async fetch(input: string | URL | Request, init: FetchOptions = {}): Promise<Response> {
    const { tenantId, anonymous, ...rest } = init;
    if (anonymous) {
      return this.transport.fetchImpl(input as RequestInfo, rest);
    }

    const tid = tenantId ?? this.tokens.getCurrentTenant();
    if (!tid) throw new RealmError("unauthorized", "no current tenant");

    const access = await this.tokens.get(tid);
    const res = await this.doFetch(input, rest, access);
    if (res.status !== 401) return res;

    // Single retry: refresh once, replay.
    const fresh = await this.tokens.refresh(tid);
    if (fresh === access) return res; // refresh produced the same token — give up
    return this.doFetch(input, rest, fresh);
  }

  private async doFetch(input: string | URL | Request, init: RequestInit, accessToken: string): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);
    return this.transport.fetchImpl(input as RequestInfo, { ...init, headers });
  }

  /* -------------------------------------------------- internals */

  private applyLoginResponse(body: LoginResponse): void {
    const tid = body.defaultTenantId ?? body.tenants[0]?.id ?? null;
    if (tid) {
      this.tokens.set(tid, body.accessToken, body.expiresIn);
      this.tokens.setCurrentTenant(tid);
    }
    this.setState({
      status: "authenticated",
      user: body.user,
      tenants: body.tenants,
      currentTenantId: tid,
    });
    this.events.emit({ type: "login", user: body.user, tenants: body.tenants, currentTenantId: tid });
  }

  private applyMe(body: MeResponse): void {
    const tid = body.currentTenantId ?? body.tenants[0]?.id ?? null;
    this.tokens.setCurrentTenant(tid);
    this.setState({
      status: "authenticated",
      user: body.user,
      tenants: body.tenants,
      currentTenantId: tid,
    });
    this.events.emit({ type: "ready", user: body.user, tenants: body.tenants, currentTenantId: tid });
  }

  private handleSessionLost(reason: "expired" | "replaced" | "revoked"): void {
    this.tokens.clear();
    this.setState({ status: "anonymous", user: null, tenants: [], currentTenantId: null });
    this.events.emit({ type: "logout", reason });
    this.bus.post({ type: "logout", reason });
  }

  private setState(next: AuthState): void {
    this.state = next;
  }

  private onTabMessage(msg: { type: string; reason?: string; tenantId?: string }): void {
    switch (msg.type) {
      case "logout":
        if (this.state.status !== "anonymous") {
          this.tokens.clear();
          this.setState({ status: "anonymous", user: null, tenants: [], currentTenantId: null });
          const reason = (["user", "expired", "replaced", "revoked"] as const).find((r) => r === msg.reason) ?? "user";
          this.events.emit({ type: "logout", reason });
        }
        break;
      case "login":
        // Another tab logged in; re-pull /me to mirror state.
        this.restore().catch(() => {});
        break;
      case "tenant_switched":
        if (msg.tenantId) {
          this.tokens.setCurrentTenant(msg.tenantId);
          this.setState({ ...this.state, currentTenantId: msg.tenantId });
          this.events.emit({ type: "tenant_switched", currentTenantId: msg.tenantId });
        }
        break;
      case "token_refreshed":
        this.events.emit({ type: "token_refreshed" });
        break;
    }
  }

  /** Tear down listeners — useful in tests + SSR rehydration. */
  close(): void {
    this.bus.close();
    this.tokens.clear();
  }

  /* exposed for adapters that need direct access */
  get _transport(): Transport {
    return this.transport;
  }
}

export function createRealm(cfg: RealmConfig): Realm {
  return new Realm(cfg);
}

// Re-export user-facing types for convenience.
export type { UserSummary, TenantRef };
