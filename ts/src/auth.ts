/**
 * Authentication surface — `realm.auth.*` per SPEC §4.
 * Maps directly onto POST /auth/{login,token,mfa/verify,logout} and the
 * /auth/sessions management endpoints.
 */

import type { HttpClient } from "./http.js";

export type LoginMethod = "firebase" | "google";

export interface LoginRequest {
  method: LoginMethod;
  providerToken: string;
  /** Optional Origin header override (server resolves realm by host if set). */
  origin?: string;
  /** Custom claims to merge into the minted access token (subject to allowlist). */
  customClaims?: Record<string, unknown>;
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
  /** Roadmap: ignored by server today. SPEC §4.2. */
  customClaims?: Record<string, unknown>;
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
}

export interface LogoutRequest {
  refreshToken?: string;
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

export class AuthClient {
  constructor(
    private readonly http: HttpClient,
    private readonly realmId: string,
  ) {}

  /**
   * SPEC §4.1 — exchange a provider token for a realm-scoped session.
   * Throws RealmError("mfa_required") with details.mfa_challenge_token when
   * the server demands an MFA challenge.
   */
  async login(req: LoginRequest): Promise<LoginResponse> {
    const headers: Record<string, string> = {};
    if (req.origin) headers["origin"] = req.origin;
    const raw = await this.http.request<RawAuthResponse>({
      method: "POST",
      path: "/auth/login",
      headers,
      body: {
        realm_id: this.realmId,
        method: req.method,
        provider_token: req.providerToken,
        custom_claims: req.customClaims,
      },
    });
    return mapAuthResp(raw);
  }

  /** SPEC §4.2 — refresh-token rotation + tenant switch. */
  async token(req: TokenRequest): Promise<TokenResponse> {
    const raw = await this.http.request<RawTokenResponse>({
      method: "POST",
      path: "/auth/token",
      body: {
        realm_id: this.realmId,
        refresh_token: req.refreshToken,
        tenant_id: req.tenantId,
        // custom_claims accepted for forward-compat; server ignores today.
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
    const raw = await this.http.request<RawAuthResponse>({
      method: "POST",
      path: "/auth/mfa/verify",
      body: {
        realm_id: this.realmId,
        challenge_token: req.challengeToken,
        code: req.code,
        method: req.method ?? "totp",
      },
    });
    return mapAuthResp(raw);
  }

  /** SPEC §4.4 — revoke the supplied (or current) refresh token. */
  async logout(req?: LogoutRequest): Promise<{ status: string }> {
    return this.http.request<{ status: string }>({
      method: "POST",
      path: "/auth/logout",
      body: {
        realm_id: this.realmId,
        refresh_token: req?.refreshToken,
      },
    });
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
