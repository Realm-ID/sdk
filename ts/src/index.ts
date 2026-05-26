/**
 * @realmid/sdk — Partner SDK for Realm ID.
 *
 * Covers login, refresh, MFA, verify, and management (tenants, users,
 * invitations, domains, API keys). Stdlib-only: uses globalThis.fetch
 * and Web Crypto, runs in Node >= 20, Deno, Bun, edge runtimes, and
 * modern browsers.
 *
 * Quick start:
 *   import { createRealm } from "@realmid/sdk";
 *   const realm = createRealm({ realmId, apiKey: "rk_live_..." });
 *   const claims = await realm.verify(accessToken);
 */

export { createRealm } from "./realm.js";
export type { Realm, RealmConfig } from "./realm.js";

export { createVerifier, Verifier } from "./verifier.js";
export type { VerifierConfig, VerifyOptions } from "./verifier.js";

export { MemRevocationCache } from "./revocation.js";
export type { RevocationCache } from "./revocation.js";

export { TokensClient, TokenRevokedError } from "./tokens.js";

export { RealmError } from "./errors.js";
export type { ErrorCode } from "./errors.js";

export type { Claims } from "./claims.js";

export type { Logger } from "./logger.js";

export type {
  LoginRequest,
  LoginResponse,
  TokenRequest,
  TokenResponse,
  MfaVerifyRequest,
  MfaChallengeMintRequest,
  MfaChallengeMintResponse,
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
export { OriginsClient, normalizeOrigin } from "./origins.js";
export type { Origin, OriginListOpts, OriginValidateOpts } from "./origins.js";
export type { RealmInfo } from "./info.js";
export type { ApiKey, ApiKeyCreate } from "./api-keys.js";

export { OWNER, MEMBER } from "./roles.js";
export type {
  Role,
  RoleObject,
  RoleListPage,
  RoleListOpts,
  RoleCreate,
  RolePatch,
} from "./roles.js";

export type { Paginated, Page, PageOpts } from "./pagination.js";

export { AdminClient } from "./admin.js";
export type {
  AdminPlatformsResponse,
  AdminStats,
  AdminEventsResponse,
  AdminSearchResponse,
  AuditEvent,
  PlatformOwner,
  PlatformSummary,
  SearchHit,
  ListPlatformsOpts,
  ListEventsOpts,
} from "./admin.js";

export { AuditEventsClient } from "./audit-events.js";
export type { AuditEventsResponse, ListAuditEventsOpts } from "./audit-events.js";

export { createMiddleware, globMatch } from "./middleware.js";
export type {
  MiddlewareConfig,
  ConnectMiddleware,
  ConnectReq,
  ConnectRes,
  NextFn,
} from "./middleware.js";
