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
 */

export { createRealm, Realm } from "./realm.js";
export type { FetchOptions } from "./realm.js";

export { RealmError } from "./errors.js";
export type { ErrorCode } from "./errors.js";

export type {
  AuthEvent,
  AuthState,
  Endpoints,
  IdentityProvider,
  LoginMethod,
  LoginRequest,
  LoginResponse,
  MeResponse,
  ProvidersResponse,
  RealmConfig,
  TenantRef,
  TokenResponse,
  UserSummary,
} from "./types.js";

export { DEFAULT_ENDPOINTS } from "./types.js";
