/**
 * Public types for @realmid/web. Mirror the BFF contract pinned in
 * sdk/web/BFF-SPEC.md. Types are intentionally lenient on optional fields
 * so partner BFFs can extend the response shape without breaking the SDK.
 */

export type LoginMethod = "firebase" | "google" | "password" | "otp";

export interface LoginRequest {
  method: LoginMethod;
  providerToken?: string;
  email?: string;
  password?: string;
  otpCode?: string;
  /** Optional tenant pin — server may use to scope discovery / signup. */
  tenantId?: string;
}

export interface UserSummary {
  id: string;
  email?: string;
  displayName?: string;
  [k: string]: unknown;
}

export interface TenantRef {
  id: string;
  role: string;
  displayName?: string;
}

export interface LoginResponse {
  accessToken: string;
  expiresIn: number;
  expiresAt?: string;
  user: UserSummary;
  tenants: TenantRef[];
  defaultTenantId?: string;
  /** MFA gate — if present, callers must run mfa.verify before tokens are usable. */
  mfa?: { challengeId: string; method: string };
}

export interface TokenResponse {
  accessToken: string;
  expiresIn: number;
  expiresAt?: string;
}

export interface IdentityProvider {
  id: string;
  provider: string;
  clientType: "web" | "ios" | "android" | "desktop" | "other";
  clientId?: string;
  allowedOrigins?: string[];
  enabled: boolean;
}

export interface ProvidersResponse {
  providers: IdentityProvider[];
  signupMode?: "closed" | "allowlist" | "open";
  allowedSignupDomains?: string[];
}

export interface MeResponse {
  user: UserSummary;
  tenants: TenantRef[];
  currentTenantId?: string;
  expiresAt?: string;
}

export type AuthEvent =
  | { type: "ready"; user: UserSummary | null; tenants: TenantRef[]; currentTenantId: string | null }
  | { type: "login"; user: UserSummary; tenants: TenantRef[]; currentTenantId: string | null }
  | { type: "tenant_switched"; currentTenantId: string }
  | { type: "token_refreshed" }
  | { type: "logout"; reason: "user" | "expired" | "replaced" | "revoked" };

export type AuthState = {
  status: "loading" | "anonymous" | "authenticated";
  user: UserSummary | null;
  tenants: TenantRef[];
  currentTenantId: string | null;
};

export interface RealmConfig {
  /** Base URL of the partner BFF. Required. */
  baseUrl: string;
  /**
   * Per-route overrides. Defaults follow `BFF-SPEC.md`:
   * { providers: "/providers", login: "/login", token: "/token",
   *   switchTenant: "/switch-tenant", mfaChallenge: "/mfa/challenge",
   *   mfaVerify: "/mfa/verify", logout: "/logout", me: "/me" }.
   */
  endpoints?: Partial<Endpoints>;
  /** Override the underlying fetch. Useful for tests + Node SSR. */
  fetch?: typeof fetch;
  /**
   * Skew (ms) before `expiresAt` at which proactive refresh fires.
   * Default 60_000. Set 0 to disable proactive refresh.
   */
  refreshSkewMs?: number;
  /**
   * Auto-restore session on construction by calling /me. Default true.
   * Disable for tests or when the partner wants to gate restore manually.
   */
  autoRestore?: boolean;
  /** Multi-tab broadcast channel name. Default "realmid:{baseUrl}". */
  channelName?: string;
}

export interface Endpoints {
  providers: string;
  login: string;
  token: string;
  switchTenant: string;
  mfaChallenge: string;
  mfaVerify: string;
  logout: string;
  me: string;
}

export const DEFAULT_ENDPOINTS: Endpoints = {
  providers: "/providers",
  login: "/login",
  token: "/token",
  switchTenant: "/switch-tenant",
  mfaChallenge: "/mfa/challenge",
  mfaVerify: "/mfa/verify",
  logout: "/logout",
  me: "/me",
};
