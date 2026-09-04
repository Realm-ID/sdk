import { RealmError } from "./errors.js";
import { Observable } from "./observable.js";
import { Transport } from "./transport.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  isOidcProvider,
  readCallback,
  OIDC_STORAGE_KEY,
  type PendingOidc,
} from "./oidc.js";
import { signInWithFirebase } from "./firebase-driver.js";
import { TokenManager } from "./token-manager.js";
import { createTabBus, type TabBus } from "./multi-tab.js";
import { resolveExpiresIn } from "./util.js";
import { memoryStorage, type StorageAdapter, type StoredSession } from "./storage.js";
import type {
  AuthEvent,
  AuthState,
  GateRule,
  IdentityProvider,
  LoginMethod,
  LoginRequest,
  LoginResponse,
  MeResponse,
  ProvidersResponse,
  RealmConfig,
  RequestAdapters,
  ResponseAdapters,
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
  private adapters: ResponseAdapters;
  private requestAdapters: RequestAdapters;
  private gates: GateRule[];
  private tenantQueryParam: string;
  private clientTypeQueryParam: string;
  private switchEndpoint: string | null;
  private loginEndpoint: string;
  private state: AuthState = {
    status: "loading",
    user: null,
    tenants: [],
    currentTenantId: null,
  };
  private mfaPending: { challengeId?: string; challengeToken?: string; method?: string } | null = null;
  // Provider credential retained across a `tenants_required` gate so the tenant
  // pick re-submits the SAME token (see resolveTenant) rather than re-running
  // the provider redirect/popup. Single-use: cleared on session issue / anon.
  private pendingProviderLogin: { method: LoginMethod; providerToken: string } | null = null;
  private restorePromise: Promise<void> | null = null;
  private storage: StorageAdapter;
  private tokenless: boolean;

  constructor(cfg: RealmConfig) {
    this.transport = new Transport(cfg);
    this.adapters = cfg.adapters ?? {};
    this.requestAdapters = cfg.requestAdapters ?? {};
    this.gates = cfg.gates ?? [];
    this.tenantQueryParam = cfg.tenantQueryParam ?? "tenant_id";
    this.clientTypeQueryParam = cfg.clientTypeQueryParam ?? "client_type";
    this.switchEndpoint = this.transport.endpoints.switchTenant;
    this.loginEndpoint = this.transport.endpoints.login;
    this.storage = cfg.storage ?? memoryStorage();
    this.tokenless = cfg.refresh?.tokenless ?? false;

    const skew = cfg.refreshSkewMs ?? 60_000;
    this.tokens = new TokenManager(this.transport, {
      refreshSkewMs: skew,
      onRefreshed: () => {
        this.events.emit({ type: "token_refreshed" });
        this.bus.post({ type: "token_refreshed" });
      },
      onLost: (reason) => {
        this.handleSessionLost(reason as "expired" | "replaced" | "revoked");
      },
      adapters: this.adapters,
      requestAdapters: this.requestAdapters,
      gates: this.gates,
      refresh: cfg.refresh ?? {},
    });

    const channel = cfg.channelName ?? `realmid:${this.transport.baseUrl}`;
    this.bus = createTabBus(channel);
    this.bus.subscribe((msg) => this.onTabMessage(msg));

    if (cfg.autoRestore !== false) {
      const stored = this.readStoredSession();
      if (stored) {
        // Paint authenticated state synchronously, then revalidate /me in
        // the background. If /me 401s the session is stale — drop to anon.
        this.adoptStored(stored);
        this.restorePromise = this.restore().catch(() => {
          /* restore handles 401 → anonymous + clears storage internally */
        });
      } else {
        this.restorePromise = this.restore().catch(() => {
          /* restore swallows — initial /me 401 is normal anonymous state */
        });
      }
    } else {
      this.setState({ ...this.state, status: "anonymous" });
    }
  }

  private readStoredSession(): StoredSession | null {
    const s = this.storage.read();
    if (!s) return null;
    // Tokenless (BFF) rotation: the stored `accessToken` is the DURABLE opaque
    // session bearer — rotated server-side, the client keeps the same value —
    // and `expiresAt` is only the short-lived access-JWT hint (~15m). It must
    // NOT gate session survival. Discarding the snapshot here dropped the
    // bearer, so the next reload's /me went out unauthenticated → the BFF
    // 401'd `session_missing` → sign-out on any reload >15m after the last
    // mint (RCA 2026-07-01). Keep it; restore()'s authenticated /me is the
    // authority and clears storage on a real 401.
    if (this.tokenless) return s;
    const nowSec = Math.floor(Date.now() / 1000);
    // Classic (self-expiring bearer): a past-expiry token is genuinely dead —
    // 5s skew so the SDK doesn't paint state we're about to throw away.
    if (s.expiresAt <= nowSec + 5) {
      this.storage.clear();
      return null;
    }
    return s;
  }

  private adoptStored(s: StoredSession): void {
    if (!s.user || !s.tenantId) return;
    try {
      this.adopt({
        accessToken: s.accessToken,
        expiresAt: s.expiresAt,
        tenantId: s.tenantId,
        user: s.user,
        tenants: s.tenants,
      });
    } catch {
      this.storage.clear();
    }
  }

  private persistSession(): void {
    const tid = this.tokens.getCurrentTenant();
    if (!tid || this.state.status !== "authenticated" || !this.state.user) return;
    const accessToken = this.tokens.peek(tid) ?? "";
    const expiresAtMs = this.tokens.peekExpiresAt(tid);
    if (expiresAtMs === undefined) return;
    const expiresAt = Math.floor(expiresAtMs / 1000);
    this.storage.write({
      accessToken,
      expiresAt,
      tenantId: tid,
      user: this.state.user,
      tenants: this.state.tenants,
    });
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
    if (opts.tenantId) qs.set(this.tenantQueryParam, opts.tenantId);
    if (opts.clientType) qs.set(this.clientTypeQueryParam, opts.clientType);
    const path = this.transport.endpoints.providers + (qs.size ? `?${qs}` : "");
    const res = await this.transport.request<unknown>("GET", path, { gates: this.gates });
    const adapted = this.adapters.providers
      ? this.adapters.providers(res.body, { status: res.status, headers: res.headers })
      : (res.body as ProvidersResponse);
    return adapted;
  }

  /* -------------------------------------------------- sign-in (provider-driven) */

  /**
   * Sign in with an identity provider configured in RI. The SDK fetches the
   * provider's public config from `realm.providers()` — so the app needs NO
   * provider config of its own, only the BFF base URL.
   *
   *  - `microsoft` / `google` (plain OIDC): redirects to the IdP with a PKCE
   *    challenge; this call does not return (the page navigates away). On the
   *    way back, call `completeSignIn()` to finish.
   *  - `firebase`: opens a popup via the lazily-loaded Firebase SDK (init'd
   *    from RI's served config) and resolves with the LoginResponse.
   */
  async signIn(
    type: string,
    opts: { tenantId?: string; redirectUri?: string } = {},
  ): Promise<LoginResponse | void> {
    const provider = await this.resolveProvider(type, opts.tenantId);

    if (type === "firebase") {
      // The Firebase project id is the row's client_id; the rest of the
      // public web config (apiKey/authDomain/appId) rides in `config`.
      const fbConfig = { projectId: provider.clientId, ...(provider.config ?? {}) };
      const idToken = await signInWithFirebase(fbConfig);
      return this.login({
        method: "firebase" as LoginRequest["method"],
        providerToken: idToken,
        tenantId: opts.tenantId,
      });
    }

    if (!isOidcProvider(type)) {
      throw new RealmError("unsupported_provider", `sign-in for "${type}" is not supported`);
    }
    const clientId = provider.clientId;
    if (!clientId) {
      throw new RealmError("provider_not_configured", `no client_id configured for ${type}`);
    }
    const store = this.requireOidcStore();
    const redirectUri = opts.redirectUri ?? defaultRedirectUri();
    const { url, pending } = await buildAuthorizeUrl({ type, clientId, redirectUri, tenantId: opts.tenantId });
    store.setItem(OIDC_STORAGE_KEY, JSON.stringify(pending));
    window.location.assign(url); // navigates away
  }

  /**
   * Complete an OIDC redirect sign-in. Call once on app load: if the URL is a
   * provider callback (`?code&state`), exchanges the code for an id_token and
   * logs in, returning the LoginResponse; otherwise returns null. Cleans the
   * OIDC params from the URL on success.
   */
  async completeSignIn(): Promise<LoginResponse | null> {
    const store = this.oidcStore();
    if (!store || typeof window === "undefined") return null;
    const cb = readCallback(window.location.search);
    if (!cb) return null;
    const raw = store.getItem(OIDC_STORAGE_KEY);
    if (!raw) return null;
    let pending: PendingOidc;
    try {
      pending = JSON.parse(raw) as PendingOidc;
    } catch {
      store.removeItem(OIDC_STORAGE_KEY);
      return null;
    }
    store.removeItem(OIDC_STORAGE_KEY);
    if (pending.state !== cb.state) {
      throw new RealmError("oidc_state_mismatch", "OIDC state did not match");
    }
    const idToken = await exchangeCode({
      type: pending.type,
      code: cb.code,
      verifier: pending.verifier,
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      fetchImpl: this.transport.fetchImpl,
    });
    stripOidcParams();
    return this.login({
      method: pending.type as LoginRequest["method"],
      providerToken: idToken,
      tenantId: pending.tenantId,
    });
  }

  private async resolveProvider(type: string, tenantId?: string): Promise<IdentityProvider> {
    const resp = await this.providers({ tenantId, clientType: "web" });
    const row = resp.providers.find((p) => p.provider === type || (p as { type?: string }).type === type);
    if (!row) {
      throw new RealmError("provider_not_configured", `no ${type} provider configured for this realm`);
    }
    return row;
  }

  private oidcStore(): Storage | null {
    try {
      return typeof window !== "undefined" ? window.sessionStorage : null;
    } catch {
      return null;
    }
  }

  private requireOidcStore(): Storage {
    const s = this.oidcStore();
    if (!s) throw new RealmError("no_browser", "signIn() requires a browser environment");
    return s;
  }

  /* -------------------------------------------------- session */

  async restore(): Promise<void> {
    try {
      const res = await this.transport.request<unknown>("GET", this.transport.endpoints.me, {
        // Attach the current session bearer so the revalidation is
        // authenticated. The BFF's /me requires it (loadSession → 401
        // `session_missing` when the Authorization bearer is absent), and the
        // refresh path already attaches it. Omitting it here sent a bearerless
        // /me that always 401'd, dropping the just-adopted session to anonymous
        // and racing the app's own authed /me → the reload sign-out
        // (RCA 2026-07-01). undefined when there's no session (initial probe).
        accessToken: this.tokens.peek() ?? undefined,
        gates: this.gates,
      });
      const adapted = this.adapters.me
        ? this.adapters.me(res.body, { status: res.status, headers: res.headers })
        : (res.body as MeResponse);
      this.applyMe(adapted);
    } catch (err) {
      if (err instanceof RealmError) {
        // ADR-107 D11: `token_stale` is a 401 that must NOT tear the session
        // down. The user stays signed in and refreshes into a token that
        // describes their new authority — and on a PROMOTION, signing them out
        // here would end the session on a grant that just widened their access.
        // It is listed before the blanket `status === 401` because that blanket
        // is exactly what would swallow it.
        if (err.code === "token_stale") {
          return;
        }
        if (err.status === 401 || err.code === "unauthorized" || err.code === "session_expired" || err.code === "session_replaced" || err.code === "session_revoked") {
          this.tokens.clear();
          this.setAnonymous();
          this.storage.clear();
          this.events.emit({ type: "ready", user: null, tenants: [], currentTenantId: null });
          return;
        }
        if (err.code === "network_error" || err.code === "server_error") {
          this.setState({
            status: "error",
            user: null,
            tenants: [],
            currentTenantId: null,
            errorReason: err.code,
          });
          this.events.emit({ type: "error", reason: err.code });
          throw err;
        }
      }
      this.setAnonymous();
      this.events.emit({ type: "ready", user: null, tenants: [], currentTenantId: null });
    }
  }

  async login(req: LoginRequest): Promise<LoginResponse> {
    const wireBody = this.requestAdapters.login ? this.requestAdapters.login(req) : req;
    try {
      const res = await this.transport.request<unknown>("POST", this.loginEndpoint, {
        body: wireBody,
        gates: this.gates,
      });
      const body = this.adaptLogin(res.body, res.status, res.headers);
      return this.handleLoginResponse(body);
    } catch (err) {
      // Gate-thrown errors (412 MFA, 412 session_limit, etc.) bypass
      // handleLoginResponse — but callers will want the same internal
      // state hooks (mfaPending, state.pendingTenants) so the follow-up
      // verify / pick-tenant calls work uniformly.
      if (err instanceof RealmError) {
        if (err.code === "mfa_required" || err.code === "mfa_registration_required") {
          const b = (err.body ?? {}) as { challengeToken?: string; challengeId?: string; method?: string };
          this.mfaPending = {
            challengeId: b.challengeId,
            challengeToken: b.challengeToken,
            method: b.method ?? "totp",
          };
        } else if (err.code === "tenants_required") {
          const b = (err.body ?? {}) as { tenants?: TenantRef[]; raw?: unknown };
          const tenants = b.tenants ?? extractTenants(b.raw);
          if (tenants && tenants.length > 0) {
            this.setState({ ...this.state, pendingTenants: tenants });
          }
          // Retain the provider token so resolveTenant() can re-submit it with
          // the chosen tenant — no second provider redirect. Only for
          // provider-driven logins (a tenant-pin re-call carries no token).
          if (req.providerToken) {
            this.pendingProviderLogin = { method: req.method, providerToken: req.providerToken };
          }
        }
      }
      throw err;
    }
  }

  /**
   * Complete a `tenants_required` gate raised by a provider-driven login
   * (`signIn` / `completeSignIn` / `login`) by re-submitting the SAME provider
   * token with the chosen tenant. This avoids a second provider redirect/popup
   * — the redirect flows (microsoft/google OIDC) do not otherwise retain the
   * exchanged id_token, so without this the app would re-run the whole IdP
   * round-trip just to attach a tenant. Throws `no_pending_login` if there is
   * no retained provider login (e.g. the gate came from a non-provider flow, or
   * the token was already consumed / a session was issued).
   */
  async resolveTenant(tenantId: string): Promise<LoginResponse> {
    const pending = this.pendingProviderLogin;
    if (!pending) {
      throw new RealmError(
        "no_pending_login",
        "no pending provider login to resolve; sign in again",
      );
    }
    return this.login({ method: pending.method, providerToken: pending.providerToken, tenantId });
  }

  async logout(): Promise<void> {
    try {
      await this.transport.request("POST", this.transport.endpoints.logout, {
        body: {},
        gates: this.gates,
      });
    } catch (err) {
      if (!(err instanceof RealmError) || (err.status !== 401 && err.status !== 404)) throw err;
    }
    this.tokens.clear();
    this.setAnonymous();
    this.storage.clear();
    this.events.emit({ type: "logout", reason: "user" });
    this.bus.post({ type: "logout", reason: "user" });
  }

  async switchTenant(tenantId: string): Promise<void> {
    if (!this.state.tenants.find((t) => t.id === tenantId)) {
      throw new RealmError("tenant_not_found", `tenant ${tenantId} not in current session`);
    }

    if (this.switchEndpoint) {
      const wireBody = this.requestAdapters.switchTenant
        ? this.requestAdapters.switchTenant({ tenantId })
        : { tenantId };
      const res = await this.transport.request<unknown>("POST", this.switchEndpoint, {
        body: wireBody,
        // Authenticated call: attach the current bearer so a BFF that re-pins
        // server-side can load the session. Without this the request is
        // anonymous and the BFF rejects it (missing session bearer).
        accessToken: this.tokens.peek() ?? undefined,
        gates: this.gates,
      });
      const adapted = this.adapters.token
        ? this.adapters.token(res.body, {
            status: res.status,
            headers: res.headers,
            currentAccessToken: this.tokens.peek() ?? undefined,
          })
        : (res.body as { accessToken?: string; expiresIn?: number; expiresAt?: string | number });
      const expiresIn = resolveExpiresIn(adapted.expiresIn, adapted.expiresAt);
      if (expiresIn === undefined) {
        throw new RealmError("server_error", "switch-tenant response missing expiry");
      }
      const accessToken = adapted.accessToken ?? this.tokens.peek() ?? "";
      this.tokens.set(tenantId, accessToken, expiresIn);
      this.tokens.setCurrentTenant(tenantId);
    } else {
      // Fallback: call /login again with tenantId. Used by BFFs that collapse
      // tenant pinning into the login round-trip.
      const canonical: LoginRequest = { method: "tenant-pin" as LoginRequest["method"], tenantId };
      const wireBody = this.requestAdapters.login ? this.requestAdapters.login(canonical) : canonical;
      const res = await this.transport.request<unknown>("POST", this.loginEndpoint, {
        body: wireBody,
        gates: this.gates,
      });
      const body = this.adaptLogin(res.body, res.status, res.headers);
      // We expect tokens this time; treat as authenticated.
      this.handleLoginResponse(body);
    }

    this.setState({ ...this.state, currentTenantId: tenantId });
    this.persistSession();
    this.events.emit({ type: "tenant_switched", currentTenantId: tenantId });
    this.bus.post({ type: "tenant_switched", tenantId });
  }

  /* -------------------------------------------------- mfa */

  readonly mfa = {
    pending: () => this.mfaPending,
    challenge: async (req: { method: string; destination?: string }): Promise<{ challengeId: string }> => {
      const wireBody = this.requestAdapters.mfaChallenge ? this.requestAdapters.mfaChallenge(req) : req;
      const { body } = await this.transport.request<{ challengeId: string }>(
        "POST",
        this.transport.endpoints.mfaChallenge,
        { body: wireBody, gates: this.gates },
      );
      this.mfaPending = { challengeId: body.challengeId, method: req.method };
      return body;
    },
    verify: async (code: string, opts: { method?: string } = {}): Promise<LoginResponse> => {
      if (!this.mfaPending) throw new RealmError("mfa_failed", "no challenge pending");
      const canonical = {
        challengeId: this.mfaPending.challengeId,
        challengeToken: this.mfaPending.challengeToken,
        code,
        method: opts.method ?? this.mfaPending.method,
      };
      const wireBody = this.requestAdapters.mfaVerify ? this.requestAdapters.mfaVerify(canonical) : canonical;
      const res = await this.transport.request<unknown>("POST", this.transport.endpoints.mfaVerify, {
        body: wireBody,
        gates: this.gates,
      });
      const adapted = this.adaptLogin(res.body, res.status, res.headers);
      this.mfaPending = null;
      return this.handleLoginResponse(adapted);
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

    // ADR-107: is this the authority-staleness 401, or an ordinary one? The
    // body is read from a CLONE — a Response body is single-use, and the caller
    // gets the original back on the hard-failure path below.
    const stale = await isTokenStaleResponse(res);

    // D13, the loop-breaker. A `token_stale` on a token that a forced refresh
    // ALREADY produced means refreshing again cannot help: the marker is ahead
    // of the issuer's clock, or the subject is being re-marked faster than a
    // token can be used. Surface the 401 rather than minting again — every
    // replica looping against the mint endpoint is what C5 calls a worse
    // outcome than the window it closes.
    if (stale && this.tokens.wasForcedFor(tid, access)) return res;

    const fresh = await this.tokens.refresh(tid);
    if (fresh === access) return res;
    if (stale) this.tokens.markForced(tid, fresh);
    return this.doFetch(input, rest, fresh);
  }

  private async doFetch(input: string | URL | Request, init: RequestInit, accessToken: string): Promise<Response> {
    const headers = new Headers(init.headers);
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
    return this.transport.fetchImpl(input as RequestInfo, { ...init, headers });
  }

  /* -------------------------------------------------- internals */

  private adaptLogin(raw: unknown, status: number, headers: Headers): LoginResponse {
    if (this.adapters.login) {
      return this.adapters.login(raw, { status, headers, currentAccessToken: this.tokens.peek() ?? undefined });
    }
    return raw as LoginResponse;
  }

  private handleLoginResponse(body: LoginResponse): LoginResponse {
    // 1. Success-body MFA gate (BFF-SPEC v0.1). Status-based MFA gates surface as RealmError already.
    if (body.mfa) {
      this.mfaPending = body.mfa;
      throw new RealmError("mfa_required", "mfa challenge pending", 0, body);
    }

    // 2. Tenant picker — successful response, no tokens, just choose a tenant.
    if (body.tenantsRequired) {
      this.setState({
        ...this.state,
        status: this.state.status === "authenticated" ? "authenticated" : "anonymous",
        pendingTenants: body.tenants ?? [],
      });
      throw new RealmError("tenants_required", "tenant selection required", 0, body);
    }

    // 3. Authenticated branch.
    if (!body.user) {
      throw new RealmError("server_error", "login response missing user", 0, body);
    }
    const tenants = body.tenants ?? [];
    const tid = body.defaultTenantId ?? tenants[0]?.id ?? null;
    const expiresIn = resolveExpiresIn(body.expiresIn, body.expiresAt);
    if (tid && body.accessToken !== undefined && expiresIn !== undefined) {
      this.tokens.set(tid, body.accessToken, expiresIn);
      this.tokens.setCurrentTenant(tid);
    } else if (tid && expiresIn !== undefined) {
      // Tokenless login (rare) — keep tenant pointer but no bearer.
      this.tokens.set(tid, "", expiresIn);
      this.tokens.setCurrentTenant(tid);
    }
    this.pendingProviderLogin = null; // session issued — retained token consumed
    this.setState({
      status: "authenticated",
      user: body.user,
      tenants,
      currentTenantId: tid,
    });
    this.persistSession();
    this.events.emit({ type: "login", user: body.user, tenants, currentTenantId: tid });
    this.bus.post({ type: "login" });
    return body;
  }

  private applyMe(body: MeResponse): void {
    const tid = body.currentTenantId ?? body.tenants[0]?.id ?? null;
    this.tokens.setCurrentTenant(tid);
    if (tid && body.expiresAt !== undefined) {
      const expiresIn = resolveExpiresIn(undefined, body.expiresAt);
      if (expiresIn !== undefined) {
        // No bearer surfaced by /me (it's session-bound on the BFF). Store
        // a placeholder so refresh schedules correctly; realm.fetch will
        // pull a fresh bearer via /token if the partner uses the
        // tokenless-rotation pattern.
        const existing = this.tokens.peek(tid);
        this.tokens.set(tid, existing ?? "", expiresIn);
      }
    }
    this.setState({
      status: "authenticated",
      user: body.user,
      tenants: body.tenants,
      currentTenantId: tid,
    });
    this.persistSession();
    this.events.emit({ type: "ready", user: body.user, tenants: body.tenants, currentTenantId: tid });
  }

  private handleSessionLost(reason: "expired" | "replaced" | "revoked"): void {
    this.tokens.clear();
    this.setAnonymous();
    this.storage.clear();
    this.events.emit({ type: "logout", reason });
    this.bus.post({ type: "logout", reason });
  }

  private setAnonymous(): void {
    this.pendingProviderLogin = null;
    this.setState({ status: "anonymous", user: null, tenants: [], currentTenantId: null });
  }

  private setState(next: AuthState): void {
    this.state = next;
  }

  private onTabMessage(msg: { type: string; reason?: string; tenantId?: string }): void {
    switch (msg.type) {
      case "logout":
        if (this.state.status !== "anonymous") {
          this.tokens.clear();
          this.setAnonymous();
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

  /**
   * Adopt an existing session that the SDK didn't mint itself — typically
   * a token persisted in sessionStorage from a prior page-load, or a
   * server-side render handoff. Sets state directly without hitting
   * /login or /me. Callers usually verify the session first (e.g. via
   * `realm.fetch("/me")` with the bearer) and pass the result here.
   *
   * If the SDK's token manager already has a different tenant, the new
   * one becomes "current".
   */
  adopt(input: {
    accessToken: string;
    expiresIn?: number;
    expiresAt?: string | number;
    tenantId: string;
    user: UserSummary;
    tenants?: TenantRef[];
  }): void {
    const expiresIn = resolveExpiresIn(input.expiresIn, input.expiresAt);
    if (expiresIn === undefined) {
      throw new RealmError("server_error", "adopt() requires expiresIn or expiresAt");
    }
    this.tokens.set(input.tenantId, input.accessToken, expiresIn);
    this.tokens.setCurrentTenant(input.tenantId);
    const tenants = input.tenants ?? [{ id: input.tenantId, role: "" }];
    this.setState({
      status: "authenticated",
      user: input.user,
      tenants,
      currentTenantId: input.tenantId,
    });
    this.persistSession();
    this.events.emit({ type: "ready", user: input.user, tenants, currentTenantId: input.tenantId });
  }

  /** Peek the current bearer for `tenantId` (default: current). Read-only. */
  peekAccessToken(tenantId?: string): string | undefined {
    return this.tokens.peek(tenantId);
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

/** Current page URL without query/hash — the default OIDC redirect_uri. */
function defaultRedirectUri(): string {
  if (typeof window === "undefined") return "";
  return window.location.origin + window.location.pathname;
}

/** Remove the OIDC callback params (`code`/`state`/`session_state`) from the
 *  address bar after a successful exchange, without a reload. */
function stripOidcParams(): void {
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  const url = new URL(window.location.href);
  for (const k of ["code", "state", "session_state", "nonce"]) url.searchParams.delete(k);
  window.history.replaceState({}, document.title, url.pathname + (url.search ? url.search : "") + url.hash);
}

/** Best-effort tenant extraction from a partner BFF's raw 412/200 body. */
function extractTenants(raw: unknown): TenantRef[] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const list = r.tenants ?? r.memberships;
  if (!Array.isArray(list)) return undefined;
  return list.map((t) => {
    const x = t as Record<string, unknown>;
    return {
      id: (x.id ?? x.tenant_id ?? "") as string,
      role: (x.role ?? "") as string,
      displayName: (x.display_name ?? x.displayName) as string | undefined,
    };
  });
}

// Re-export user-facing types for convenience.
export type { UserSummary, TenantRef };

/**
 * True when a 401 Response carries the ADR-107 `token_stale` wire code.
 *
 * Reads a CLONE so the caller still gets an unconsumed body — a Response body
 * is single-use, and handing back a drained one would turn a diagnostic read
 * into a broken response.
 */
async function isTokenStaleResponse(res: Response): Promise<boolean> {
  try {
    const body = (await res.clone().json()) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return false;
    if (body.code === "token_stale") return true;
    const nested = body.error as Record<string, unknown> | undefined;
    return !!nested && typeof nested === "object" && nested.code === "token_stale";
  } catch {
    // A non-JSON or already-consumed 401 is simply not a staleness signal.
    return false;
  }
}
