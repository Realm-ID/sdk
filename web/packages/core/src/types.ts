/**
 * Public types for @realm-id/web. The SDK speaks a *canonical* internal
 * shape (camelCase, expiresIn-or-expiresAt). Partner BFFs whose wire
 * shape diverges plug in `adapters` (see ResponseAdapters) and `gates`
 * (see GateRule) to translate. Defaults match BFF-SPEC.md.
 */

import type { StorageAdapter } from "./storage.js";

/** Login methods the spec recognises; partners may add their own. */
export type LoginMethod = "firebase" | "google" | "microsoft" | "password" | "otp" | (string & {});

export interface LoginRequest {
  method: LoginMethod;
  providerToken?: string;
  email?: string;
  password?: string;
  otpCode?: string;
  /** Optional tenant pin — server may use to scope discovery / signup. */
  tenantId?: string;
  /** Pass-through for partner-specific fields (e.g. realmId, captchaToken). */
  [k: string]: unknown;
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
  /** Per-tenant MFA policy hint surfaced by some BFFs. Optional; partners ignore if unused. */
  mfaRequired?: boolean;
}

/**
 * Canonical login response. Adapters normalise partner BFFs into this
 * shape. All fields are optional because:
 *
 *  - `tenantsRequired: true` branch carries no tokens, just a picker.
 *  - `mfa` branch (success-body MFA gate) carries no tokens until verify.
 *  - HTTP-status gates surface as errors before this object is built.
 */
export interface LoginResponse {
  accessToken?: string;
  expiresIn?: number;
  expiresAt?: string | number;
  user?: UserSummary;
  tenants?: TenantRef[];
  defaultTenantId?: string;
  /** Success-body MFA gate (BFF-SPEC v0.1). Status-based gates raise errors instead. */
  mfa?: { challengeId?: string; challengeToken?: string; method?: string };
  /** When set, no tokens were issued — caller must pick a tenant and re-login. */
  tenantsRequired?: boolean;
  /** Realm id echoed by some BFFs after login (informational). */
  realmId?: string;
  [k: string]: unknown;
}

export interface TokenResponse {
  /**
   * Access token, if rotated. Absent for "tokenless rotation" BFFs that
   * keep one opaque session bearer and only advance its expiry. The
   * SDK will keep using the previous bearer in that case.
   */
  accessToken?: string;
  expiresIn?: number;
  expiresAt?: string | number;
}

export interface IdentityProvider {
  id: string;
  provider: string;
  clientType: "web" | "ios" | "android" | "desktop" | "other" | (string & {});
  clientId?: string;
  allowedOrigins?: string[];
  enabled: boolean;
  [k: string]: unknown;
}

export interface ProvidersResponse {
  providers: IdentityProvider[];
  signupMode?: "closed" | "allowlist" | "open" | (string & {});
  allowedSignupDomains?: string[];
}

export interface MeResponse {
  user: UserSummary;
  tenants: TenantRef[];
  currentTenantId?: string;
  expiresAt?: string | number;
}

export type AuthEvent =
  | { type: "ready"; user: UserSummary | null; tenants: TenantRef[]; currentTenantId: string | null }
  | { type: "login"; user: UserSummary; tenants: TenantRef[]; currentTenantId: string | null }
  | { type: "tenant_switched"; currentTenantId: string }
  | { type: "token_refreshed" }
  | { type: "logout"; reason: "user" | "expired" | "replaced" | "revoked" }
  | { type: "error"; reason: string };

export type AuthStatus = "loading" | "anonymous" | "authenticated" | "error";

export type AuthState = {
  status: AuthStatus;
  user: UserSummary | null;
  tenants: TenantRef[];
  currentTenantId: string | null;
  /** Populated transiently when login surfaces a tenants_required gate. */
  pendingTenants?: TenantRef[];
  /** Populated when restore failed for non-auth reasons (network/5xx). */
  errorReason?: string;
};

/* -------------------------------------------------- adapter layer */

export interface AdapterContext {
  status: number;
  headers: Headers;
  /** The access bearer the SDK is currently using; tokenless refreshes keep it. */
  currentAccessToken?: string;
}

export interface ResponseAdapters {
  login?: (raw: unknown, ctx: AdapterContext) => LoginResponse;
  me?: (raw: unknown, ctx: AdapterContext) => MeResponse;
  token?: (raw: unknown, ctx: AdapterContext) => TokenResponse;
  providers?: (raw: unknown, ctx: AdapterContext) => ProvidersResponse;
}

/**
 * Translate the SDK's canonical request bodies into whatever wire shape
 * the partner BFF expects. Symmetric to ResponseAdapters. Each adapter
 * returns the body the SDK should JSON.stringify and POST.
 *
 * Defaults (when no adapter is supplied) post the canonical SDK shape
 * unchanged: `{ method, providerToken, email, password, otpCode, tenantId }`
 * for login etc.
 */
export interface RequestAdapters {
  login?: (canonical: LoginRequest) => unknown;
  /** Body for POST /token. Canonical input is `{ tenantId }`. */
  token?: (canonical: { tenantId: string }) => unknown;
  /** Body for POST /switch-tenant. Canonical input is `{ tenantId }`. */
  switchTenant?: (canonical: { tenantId: string }) => unknown;
  /** Body for POST /mfa/challenge. */
  mfaChallenge?: (canonical: { method: string; destination?: string }) => unknown;
  /** Body for POST /mfa/verify. SDK passes the canonical
   *  `{ challengeId?, challengeToken?, code, method? }`. */
  mfaVerify?: (canonical: { challengeId?: string; challengeToken?: string; code: string; method?: string }) => unknown;
}

/* -------------------------------------------------- gate layer */

export type GateCode =
  | "mfa_required"
  | "mfa_registration_required"
  | "session_limit_reached"
  | "tenants_required";

export interface GateRule {
  /** HTTP status to match. Use 200 for success-body gates. */
  status: number;
  /** Match a body-level `code` field (string or list). Optional. */
  code?: string | string[];
  /** Where in the body the `code` lives. Default: top-level "code", then "error.code". */
  codePath?: string[];
  /** Gate this rule fires. */
  gate: GateCode;
  /** Pluck the gate's payload (e.g. challengeToken, revocationToken). */
  extract?: (body: unknown) => Record<string, unknown>;
}

/* -------------------------------------------------- transport extras */

export interface CSRFConfig {
  headerName: string;
  /** Read the token from a cookie of this name (browser only). */
  cookieName?: string;
  /** Or compute the token on demand. Async-friendly. */
  tokenProvider?: () => string | Promise<string>;
}

export interface RefreshConfig {
  /** Send `Authorization: Bearer <current access>` on /token. Default false. */
  sendBearer?: boolean;
  /**
   * BFF rotates server-side and /token returns no accessToken (only an
   * advanced expiry). The SDK keeps using the existing bearer. Default false.
   */
  tokenless?: boolean;
}

export interface RealmConfig {
  /** Base URL of the partner BFF. Required. */
  baseUrl: string;
  /** Per-route overrides. Defaults follow BFF-SPEC.md. Set switchTenant: null to fall back to login. */
  endpoints?: Partial<Endpoints>;
  /** Override the underlying fetch. Useful for tests + Node SSR. */
  fetch?: typeof fetch;
  /** Skew (ms) before expiry at which proactive refresh fires. Default 60_000. */
  refreshSkewMs?: number;
  /** Auto-restore session by calling /me on construction. Default true. */
  autoRestore?: boolean;
  /** Multi-tab broadcast channel name. Default "realmid:{baseUrl}". */
  channelName?: string;
  /** Wire-shape adapters for response bodies. */
  adapters?: ResponseAdapters;
  /** Wire-shape adapters for request bodies. */
  requestAdapters?: RequestAdapters;
  /** Status/code-based gates (MFA, session-limit, …). Defaults are empty — all gates are partner-supplied. */
  gates?: GateRule[];
  /** CSRF header injection on unsafe methods. */
  csrf?: CSRFConfig;
  /** Refresh transport tweaks. */
  refresh?: RefreshConfig;
  /** Query-param name for tenant scope on /providers. Default "tenant_id". */
  tenantQueryParam?: string;
  /** Query-param name for client type on /providers. Default "client_type". */
  clientTypeQueryParam?: string;
  /**
   * Pluggable session persistence. The SDK writes on every successful
   * adopt/login/applyMe/switchTenant, clears on logout / session-lost,
   * and reads on construction to paint state synchronously before /me
   * resolves. Default `memoryStorage()` (no cross-reload persistence —
   * cookie-based BFFs survive reload via the cookie already).
   */
  storage?: StorageAdapter;
}

export interface Endpoints {
  providers: string;
  login: string;
  token: string;
  /** Null → SDK falls back to login({tenantId}). */
  switchTenant: string | null;
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
