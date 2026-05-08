/**
 * @realmid/web — browser SDK for RealmID.
 *
 * Talks only to the partner's BFF (per ADR-052). Holds in-memory access
 * tokens; refresh credentials live in an httpOnly cookie set by the BFF.
 *
 * Quick start:
 *   import { createRealm } from "@realmid/web";
 *   const realm = createRealm({ baseUrl: "https://api.partner.com" });
 *   await realm.ready();
 *   const { providers } = await realm.providers();
 *   await realm.login({ method: "google", providerToken });
 *   const res = await realm.fetch("/api/orders");
 *
 * Partner BFFs whose wire shape diverges from BFF-SPEC.md plug in
 * `adapters` and `gates`. See @realmid/web-bff-realmid for a worked
 * example against the realmid.dev reference BFF.
 */

export { createRealm, Realm } from "./realm.js";
export type { FetchOptions } from "./realm.js";

export { RealmError, classifyHttpStatus, extractMessage, pluckPath, DEFAULT_CODE_PATHS } from "./errors.js";
export type { ErrorCode } from "./errors.js";

export { resolveExpiresIn, parseExpiresAt } from "./util.js";

export type {
  AdapterContext,
  AuthEvent,
  AuthState,
  AuthStatus,
  CSRFConfig,
  Endpoints,
  GateCode,
  GateRule,
  IdentityProvider,
  LoginMethod,
  LoginRequest,
  LoginResponse,
  MeResponse,
  ProvidersResponse,
  RealmConfig,
  RefreshConfig,
  RequestAdapters,
  ResponseAdapters,
  TenantRef,
  TokenResponse,
  UserSummary,
} from "./types.js";

export { DEFAULT_ENDPOINTS } from "./types.js";
