/**
 * Authentication surface — `realm.auth.*` per SPEC §4.
 * Maps directly onto POST /auth/{login,token,mfa/verify,mfa/challenge,logout}
 * and the /auth/sessions management endpoints.
 *
 * Authorization on every call is the short-lived platform token — the raw
 * API key never travels on login traffic (SPEC §4.0). The HttpClient
 * injects that automatically; this module does not have to think about it.
 *
 * Origin auto-attach (SPEC §8): every auth call (login, logout, token,
 * mfa/verify, mfa/challenge) carries an `Origin` header. The value is
 * derived in priority order: per-call `origin` arg → handle-level
 * `createRealm({ origin })` → `realm.info().audience` (prefixed
 * `https://`). Callers never need to set it manually.
 */

import type { HttpClient } from "./http.js";
import { RealmError } from "./errors.js";

export type LoginMethod = "firebase" | "google";

export interface LoginRequest {
  method: LoginMethod;
  providerToken: string;
  /** Optional Origin header override (server resolves realm by host if set). */
  origin?: string;
  // NOTE: customClaims intentionally NOT accepted here. Per SPEC §4.1 the
  // refresh token carries identity only; access-token claims are minted via
  // `auth.token({ customClaims })`.
}

export interface TenantRef {
  id: string;
  role: string;
  displayName?: string;
}

export interface UserSummary {
  id: string;
  email?: string;
  displayName?: string;
  [k: string]: unknown;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  expiresAt?: string;
  user: UserSummary;
  tenants: TenantRef[];
}

export interface TokenRequest {
  refreshToken: string;
  tenantId: string;
  /**
   * v0.1.0 — custom claims merged into the minted **access token**,
   * subject to a per-realm server-side allowlist. Use this for app-state
   * fields (e.g. `outlet_ids`) that downstream services need to authorize
   * without a database lookup. The SDK is a pass-through; allowlist
   * enforcement is the server's responsibility.
   */
  customClaims?: Record<string, unknown>;
  /** Optional Origin header override. */
  origin?: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tenantId: string;
  role: string;
}

export interface MfaVerifyRequest {
  challengeToken: string;
  code: string;
  /** Defaults to "totp". */
  method?: string;
  /** Optional Origin header override. */
  origin?: string;
}

export interface LogoutRequest {
  refreshToken?: string;
  /**
   * When set AND a RevocationCache is configured on the Realm, the
   * access token's `jti` is added to the cache on successful logout —
   * bridging the gap between user logout and the access token's
   * stateless natural expiry per ADR-041 follow-up. The server-side
   * refresh revocation is independent and always happens.
   */
  accessToken?: string;
  /** Optional Origin header override. */
  origin?: string;
}

export interface MfaChallengeMintRequest {
  /** The user's current access token. */
  accessToken: string;
}

export interface MfaChallengeMintResponse {
  mfaChallengeToken: string;
  methods: string[];
}

export interface SessionInfo {
  id: string;
  createdAt?: string;
  lastUsedAt?: string;
  userAgent?: string;
  ip?: string;
  [k: string]: unknown;
}

interface RawAuthResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at?: string;
  user: UserSummary;
  tenants?: TenantRef[];
}

interface RawTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  tenant_id: string;
  role: string;
}

/** Resolves the Origin header for an auth call. Returns undefined when neither override, handle config, nor info() yields a value. */
export type OriginResolver = (perCall?: string) => Promise<string | undefined>;

export class AuthClient {
  constructor(
    private readonly http: HttpClient,
    private readonly realmId: string,
    private readonly resolveOrigin: OriginResolver,
    private readonly revocation?: import("./revocation.js").RevocationCache,
  ) {}

  /**
   * SPEC §4.1 — exchange a provider token for a realm-scoped session.
   * Throws RealmError("mfa_required") with details.mfa_challenge_token when
   * the server demands an MFA challenge.
   */
  async login(req: LoginRequest): Promise<LoginResponse> {
    const headers = await this.originHeaders(req.origin);
    const raw = await this.http.request<RawAuthResponse>({
      method: "POST",
      path: "/auth/login",
      headers,
      body: {
        realm_id: this.realmId,
        method: req.method,
        provider_token: req.providerToken,
      },
    });
    return mapAuthResp(raw);
  }

  /**
   * SPEC §4.2 — refresh-token rotation + tenant switch + custom-claim
   * injection on the minted access token. `customClaims` is a v0.1.0
   * feature; the server enforces a per-realm allowlist.
   */
  async token(req: TokenRequest): Promise<TokenResponse> {
    const headers = await this.originHeaders(req.origin);
    const raw = await this.http.request<RawTokenResponse>({
      method: "POST",
      path: "/auth/token",
      headers,
      body: {
        realm_id: this.realmId,
        refresh_token: req.refreshToken,
        tenant_id: req.tenantId,
        custom_claims: req.customClaims,
      },
    });
    return {
      accessToken: raw.access_token,
      refreshToken: raw.refresh_token,
      expiresIn: raw.expires_in,
      tenantId: raw.tenant_id,
      role: raw.role,
    };
  }

  /** SPEC §4.3 — complete an MFA challenge. Same response shape as login. */
  async mfaVerify(req: MfaVerifyRequest): Promise<LoginResponse> {
    const headers = await this.originHeaders(req.origin);
    const raw = await this.http.request<RawAuthResponse>({
      method: "POST",
      path: "/auth/mfa/verify",
      headers,
      body: {
        realm_id: this.realmId,
        challenge_token: req.challengeToken,
        code: req.code,
        method: req.method ?? "totp",
      },
    });
    return mapAuthResp(raw);
  }

  /** SPEC §4.4 — revoke the supplied (or current) refresh token.
   *  When req.accessToken is set AND the Realm has a RevocationCache
   *  wired, the access token's jti is added to the cache on success
   *  (ADR-041 follow-up). Failure to push to the cache does NOT fail
   *  the logout call; the server-side refresh revocation is the
   *  load-bearing operation. */
  async logout(req?: LogoutRequest): Promise<{ status: string }> {
    const headers = await this.originHeaders(req?.origin);
    const out = await this.http.request<{ status: string }>({
      method: "POST",
      path: "/auth/logout",
      headers,
      body: {
        realm_id: this.realmId,
        refresh_token: req?.refreshToken,
      },
    });
    if (req?.accessToken && this.revocation) {
      const { peekJwtRevokeFields } = await import("./revocation.js");
      const { jti, expMs } = peekJwtRevokeFields(req.accessToken);
      if (jti) {
        try {
          await this.revocation.revoke(jti, expMs);
        } catch {
          // Cache failure does not fail logout; server-side refresh
          // revocation is the load-bearing operation.
        }
      }
    }
    return out;
  }

  /** SPEC §4.5 — server-side revoke of a specific session id. */
  async revokeSession(sessionId: string, userBearer?: string): Promise<void> {
    await this.http.request({
      method: "DELETE",
      path: `/auth/sessions/${encodeURIComponent(sessionId)}`,
      bearer: userBearer,
    });
  }

  /** SPEC §4.6 — list sessions for the user identified by `userBearer`. */
  async listSessions(userBearer?: string): Promise<SessionInfo[]> {
    const raw = await this.http.request<{ sessions?: SessionInfo[] } | SessionInfo[]>({
      method: "GET",
      path: "/auth/sessions",
      bearer: userBearer,
    });
    if (Array.isArray(raw)) return raw;
    return raw.sessions ?? [];
  }

  /**
   * SPEC §10.1 — mint an MFA challenge token from an already-issued
   * access token. The middleware uses this to issue 412 envelopes on
   * `mfaProtectedPaths` without forcing the partner app to round-trip
   * through `auth.login` again.
   *
   * The server endpoint (`POST /auth/mfa/challenge`) is tracked as a TODO
   * in the auth-monorepo. Until the server lands it, this helper throws
   * RealmError({ code: "server_error" }) on any non-2xx response and
   * surfaces network errors normally.
   */
  async mintMfaChallenge(req: MfaChallengeMintRequest): Promise<MfaChallengeMintResponse> {
    interface Wire { mfa_challenge_token?: string; methods?: string[] }
    let raw: Wire;
    try {
      raw = await this.http.request<Wire>({
        method: "POST",
        path: "/auth/mfa/challenge",
        bearer: req.accessToken,
        // Empty body — the bearer identifies user, session, and realm.
        body: {},
      });
    } catch (e) {
      if (e instanceof RealmError && (e.httpStatus === 404 || e.httpStatus === 501)) {
        throw new RealmError({
          code: "server_error",
          message: "mfa challenge mint not yet supported by server",
          cause: e,
        });
      }
      throw e;
    }
    if (!raw || typeof raw.mfa_challenge_token !== "string") {
      throw new RealmError({
        code: "server_error",
        message: "mfa challenge mint not yet supported by server",
      });
    }
    return {
      mfaChallengeToken: raw.mfa_challenge_token,
      methods: raw.methods ?? ["totp"],
    };
  }

  private async originHeaders(perCall?: string): Promise<Record<string, string>> {
    const o = await this.resolveOrigin(perCall);
    return o ? { origin: o } : {};
  }
}

function mapAuthResp(r: RawAuthResponse): LoginResponse {
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    expiresIn: r.expires_in,
    expiresAt: r.expires_at,
    user: r.user,
    tenants: r.tenants ?? [],
  };
}
