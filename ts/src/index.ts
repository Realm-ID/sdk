/**
 * @realm-id/sdk — Partner SDK for Realm ID.
 *
 * Covers login, refresh, MFA, verify, and management (tenants, users,
 * invitations, domains, API keys). Stdlib-only: uses globalThis.fetch
 * and Web Crypto, runs in Node >= 20, Deno, Bun, edge runtimes, and
 * modern browsers.
 *
 * Quick start:
 *   import { createRealm } from "@realm-id/sdk";
 *   const realm = createRealm({ realmId, apiKey: "rk_live_..." });
 *   const claims = await realm.verify(accessToken);
 */

export { createRealm } from "./realm.js";
export type { Realm, RealmConfig } from "./realm.js";
// Workload identity federation credential sources (ADR-057).
export {
  staticApiKey,
  googleWorkloadIdentity,
  githubActionsOidc,
  DEFAULT_FEDERATION_AUDIENCE,
} from "./credential.js";
export type { CredentialSource, Credential } from "./credential.js";

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
  SelfEnrollMfaRequest,
  MfaEnrollment,
  DisableMfaRequest,
  RevokeAllSessionsRequest,
} from "./auth.js";

export { TokenManager } from "./token-manager.js";
export type { TokenManagerOptions, RefreshSink } from "./token-manager.js";

export type {
  Tenant,
  TenantCreate,
  TenantPatch,
  TenantConfigPatch,
  TransferOwnerOptions,
  UpdateUserRoleResult,
  Invitation,
  InvitationCreate,
  User,
  UserStatus,
  ImportUserRow,
  ImportUserRowResult,
  ImportUsersResult,
  DriftReview,
  DriftAcceptResult,
  DriftRejectResult,
  ContactVerification,
  ContactVerificationResult,
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

export { SigningKeysClient } from "./signing-keys.js";
export type {
  SigningKey,
  SigningKeyRotation,
  SigningKeysResponse,
  RotateSigningKeyResult,
} from "./signing-keys.js";

export { IdentityProviderConfigClient } from "./identity-provider-config.js";
export type {
  IdpConfig,
  IdpConfigCreate,
  IdpConfigPatch,
  IdpConfigListPage,
  IdpConfigListOpts,
  IdpEntityType,
  IdpProvider,
  IdpClientType,
} from "./identity-provider-config.js";

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

export { OtpClient, DELIVERY_MODE_VIEW_BFF } from "./otp.js";
export type {
  OtpDeliveryMode,
  OtpIssueRequest,
  OtpIssueResponse,
  OtpViewResponse,
  OtpVerifyRequest,
  OtpVerifyResponse,
} from "./otp.js";

export { ServiceAccountsClient } from "./service-accounts.js";
export type {
  ServiceAccount,
  ServiceAccountCreate,
  ServiceAccountRevokeResult,
} from "./service-accounts.js";

export { SourcesClient } from "./sources.js";
export type { Source, SourceCreate, SourcePatch } from "./sources.js";

export { createMiddleware, globMatch } from "./middleware.js";
export type {
  MiddlewareConfig,
  ConnectMiddleware,
  ConnectReq,
  ConnectRes,
  NextFn,
} from "./middleware.js";
