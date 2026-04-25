/**
 * @realmid/sdk — Partner SDK for Realm ID.
 *
 * Covers login, refresh, MFA, verify, and management (tenants, users,
 * invitations, domains, platform admin, API keys). Stdlib-only: uses
 * globalThis.fetch and Web Crypto, runs in Node >= 20, Deno, Bun, edge
 * runtimes, and modern browsers.
 *
 * Quick start:
 *   import { createRealm } from "@realmid/sdk";
 *   const realm = createRealm({ realmId, apiKey });
 *   const claims = await realm.verify(accessToken);
 */

export { createRealm } from "./realm.js";
export type { Realm, RealmConfig } from "./realm.js";

export { createVerifier, Verifier } from "./verifier.js";
export type { VerifierConfig, VerifyOptions } from "./verifier.js";

export { RealmError } from "./errors.js";
export type { ErrorCode } from "./errors.js";

export type { Claims } from "./claims.js";

export type {
  LoginRequest,
  LoginResponse,
  TokenRequest,
  TokenResponse,
  MfaVerifyRequest,
  LogoutRequest,
  SessionInfo,
  TenantRef,
  UserSummary,
  LoginMethod,
} from "./auth.js";

export type {
  Tenant,
  TenantCreate,
  TenantPatch,
  Invitation,
  InvitationCreate,
  User,
  UserStatus,
} from "./tenants.js";

export type { DomainClaim, DomainVerifyResult } from "./domains.js";
export type { Platform, PlatformCreate, PlatformTenant } from "./platforms.js";
export type { RealmInfo, ApiKey, ApiKeyCreate } from "./realm-self.js";

export type { Paginated, Page, PageOpts } from "./pagination.js";

export { createMiddleware, globMatch } from "./middleware.js";
export type {
  MiddlewareConfig,
  ConnectMiddleware,
  ConnectReq,
  ConnectRes,
  NextFn,
} from "./middleware.js";
