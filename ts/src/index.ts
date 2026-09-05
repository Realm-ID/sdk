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
export { MemAuthorityCache, AUTHORITY_STALE_SKEW_MS, DEFAULT_ACCESS_TTL_MS } from "./authority.js";
export type { AuthorityCache, AuthorityChange, AuthorityChangeIntent } from "./authority.js";

export { TokensClient, TokenRevokedError } from "./tokens.js";

export { RealmError, isTokenStale } from "./errors.js";
export type { ErrorCode } from "./errors.js";

export type { Claims } from "./claims.js";

export type { Logger } from "./logger.js";

export type {
  LoginRequest,
  LoginResponse,
  TenantChoice,
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
  ListAuthenticatorsRequest,
  Authenticator,
  AuthenticatorList,
  RegenerateRecoveryCodesRequest,
  RecoveryCodesResult,
} from "./auth.js";

export { TokenManager } from "./token-manager.js";
export type { TokenManagerOptions, RefreshSink } from "./token-manager.js";

export type {
  Tenant,
  TenantCreate,
  TenantOwner,
  TenantPatch,
  TenantConfigPatch,
  TransferOwnerOptions,
  UpdateUserRoleResult,
  Invitation,
  InvitationCreate,
  User,
  UserStatus,
  UserListOpts,
  InvitationListOpts,
  ImportUserRow,
  ImportUserRowResult,
  ImportUsersResult,
  DriftReview,
  DriftAcceptResult,
  DriftRejectResult,
  DelinkContactResult,
  HandBackResult,
  ContactVerification,
  ContactVerificationResult,
} from "./tenants.js";

export { SessionsClient } from "./sessions.js";
export type { SessionRevokeResult } from "./sessions.js";

export type { DomainClaim, DomainVerifyResult } from "./domains.js";
export { OriginsClient, normalizeOrigin } from "./origins.js";
export type { Origin, OriginListOpts, OriginValidateOpts } from "./origins.js";
export type { RealmInfo } from "./info.js";
export type { ApiKey, ApiKeyCreate } from "./api-keys.js";
// ADR-084 end-user API keys. capAllows is exported as a VALUE, not just a type:
// it is the helper whose signature forces the live-permission operand, so a
// partner must be able to call it rather than reimplement the intersection.
export type {
  UserApiKey,
  UserApiKeyWrite,
  UserApiKeyCreate,
  LivePermissionResolver,
} from "./user-api-keys.js";
export { capAllows, isUserApiKeyRevoked } from "./user-api-keys.js";

export { OWNER, MEMBER } from "./roles.js";
// ADR-097 §F — the realm-wide bulk scope rename.
export { ScopesClient } from "./scopes.js";
export type { ScopeRenameRequest, ScopeRenameResult } from "./scopes.js";
export type {
  Role,
  PrincipalKind,
  RoleObject,
  RoleListPage,
  RoleListOpts,
  RoleCreate,
  RolePatch,
} from "./roles.js";

// ADR-101 D1 write side — RealmID's role VOCABULARY, base-realm-gated.
export { RoleTemplatesClient, ROLE_TEMPLATE_LEVELS } from "./role-templates.js";
export type {
  RoleTemplate,
  RoleTemplateLevel,
  RoleTemplateCreate,
  RoleTemplatePatch,
  RoleTemplateCreated,
  RoleTemplatePatched,
  RoleTemplateDeleted,
} from "./role-templates.js";

export { ConfigClient } from "./config.js";
export type { RealmConfigValues, RealmConfigResponse } from "./config.js";

export { MeClient } from "./me.js";
export type {
  MeAuth,
  TenantChoiceRequest,
  TenantChoiceResult,
  MembershipRequest,
  MembershipResult,
} from "./me.js";

export { StatsClient } from "./stats.js";
export type { PlatformStats, MfaCoverage } from "./stats.js";

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

export { IdentityProvidersClient } from "./identity-providers.js";
export type {
  IdentityProvider,
  IdentityProvidersResponse,
  IdentityProvidersOptions,
} from "./identity-providers.js";

export { FederationBindingsClient } from "./federation-bindings.js";
export type {
  FederationBinding,
  FederationBindingCreate,
  FederationBindingRevokeResult,
} from "./federation-bindings.js";

export type { Paginated, Page, PageOpts } from "./pagination.js";
// readPage/writePage are exported as VALUES, not types: any consumer that
// decodes a page and re-emits it (a BFF, a proxy, a cache) needs one correct
// round trip rather than a hand-rolled object literal that quietly omits
// has_more. That omission is exactly how go/v0.53.0 deleted credential_methods.
export { paginate, readPage, writePage } from "./pagination.js";

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

export {
  OtpClient,
  DELIVERY_MODE_VIEW_BFF,
  DELIVERY_MODE_EMAIL,
  DELIVERY_MODE_SMS,
} from "./otp.js";
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
export { IntegrationsClient } from "./integrations.js";
export type {
  Integration,
  Installation,
  IntegrationCreate,
  IntegrationPatch,
  InstallRequest,
  InstallResult,
  IntegrationMintRequest,
  IntegrationMintResult,
  IntegrationListPage,
  InstallationListPage,
  IntegrationListOpts,
} from "./integrations.js";

export { createMiddleware, globMatch } from "./middleware.js";
// ADR-097: SDK-enforced route authorization. Layer 1 (predicate), layer 2
// (route map, default DENY), layer 3 (Express + Fastify adapters).
export {
  scopesFrom,
  scopeAllows,
  scopeAllowsAny,
  decideScope,
  validateScopePolicy,
  isRfc6749ScopeToken,
  createScopeMiddleware,
  fastifyScopeHook,
} from "./scope.js";
export type {
  ScopeRule,
  ScopePolicy,
  ScopeDecision,
  ScopeConfigError,
  ScopeMiddlewareOptions,
  ScopeReqLike,
  ScopeResLike,
} from "./scope.js";
// ADR-100 D9's other half: the ROLE -> scope map, to the route -> scope map
// above. Both live in the partner's repo; the SDK only evaluates them.
export { scopesForRoles, roleScopeNames, validateRoleScopes } from "./rolescope.js";
export type { RoleScopes, RoleScopeConfigError } from "./rolescope.js";
export type {
  MiddlewareConfig,
  ConnectMiddleware,
  ConnectReq,
  ConnectRes,
  NextFn,
} from "./middleware.js";

// ---------------------------------------------------------------------------
// The GoFr wire envelope (SPEC §3.1). Exported as VALUES, not just types: a
// partner BFF, a browser client and this SDK were all parsing the same three
// error shapes by hand, and the code-less framework 401 is the one every
// hand-rolled copy forgets.
export { unwrapData, parseErrorEnvelope } from "./envelope.js";
export type { ErrorEnvelope } from "./envelope.js";

// Role predicates. ADR-081 assignability + ADR-101 D6 authority, mirrored from
// the issuer (which wins) so a console never offers a choice that will 403.
export {
  isRoleAssignableTo,
  isRoleSeatable,
  rolesAssignableTo,
  confersAuthority,
  HUMAN_ONLY_PERMISSIONS,
  NON_ASSIGNABLE_ROLES,
  PRINCIPAL_KINDS,
} from "./roles.js";
export type { AssignableRole, ConfersAuthorityOptions, CatalogPermission } from "./roles.js";

// ADR-094 per-org SSO domain grants — wire shapes; the `admin.ssoDomains`
// transport lives in @realm-id/web-admin.
export { SSO_DOMAIN_METHODS, SSO_DOMAIN_PROOF_METHODS, SSO_DOMAIN_STATUSES } from "./sso-domains.js";
export type {
  SSODomainGrant,
  SSODomainMethod,
  SSODomainStatus,
  SSODomainInstructions,
  SSODomainClaimResult,
  SSODomainVerifyResult,
} from "./sso-domains.js";

// ADR-092 D5 membership self-service — the error CODE taxonomy. The codes are
// contract; the user-facing sentences stay in the application.
export { MEMBERSHIP_ACTION_CODES, isMembershipActionCode } from "./memberships.js";
export type { MembershipActionCode } from "./memberships.js";

// ADR-102 D10/D11 — the product-roles handler and the Go-parity session helpers.
export {
  ProductRolesError,
  LoginMintError,
} from "./product-roles.js";
export type { ProductRolesHandler } from "./product-roles.js";
// ADR-097 — the `scope` twin of the product-roles handler. Configure it as
// `scopes` on createRealm; `ScopesClient` above is the unrelated bulk-rename
// resource, and `scope.ts`'s helpers are the enforcement layer that reads the
// minted claim back.
export { ScopesError } from "./scopes-handler.js";
export type { ScopesHandler } from "./scopes-handler.js";
export { needsTenantChoice, selectTenant } from "./auth.js";
// The post-identity, pre-derived-claims hook (design doc:
// `../docs/design/pre-mint-hook.md`). Configure it as `onIdentityResolved` on
// `createRealm`, alongside `productRoles` and `scopes`.
export { IdentityResolvedError } from "./identity-resolved.js";
export type { AuthFlow, IdentityResolvedEvent, IdentityResolvedHandler } from "./identity-resolved.js";
