/**
 * @internal
 *
 * Internal entry point for sibling browser SDKs (e.g. `@realm-id/web-admin`)
 * that need to construct the resource clients directly against a custom
 * transport. Not intended for partner consumption — use the top-level
 * `createRealm` facade exported from `@realm-id/sdk` for that.
 *
 * Stability: the shapes re-exported here are NOT covered by the same
 * semver guarantees as the top-level public surface. They may change in
 * minor versions to track internal refactors. Pin a tight version range
 * if you depend on this entry point.
 */

export {
  TenantsClient,
  InvitationsClient,
  UsersClient,
  DriftReviewsClient,
  ContactVerificationsClient,
  type Tenant,
  type TenantCreate,
  type TenantOwner,
  type TenantPatch,
  type TenantConfigPatch,
  type SignupMode,
  type Invitation,
  type InvitationCreate,
  type User,
  type UserStatus,
  type UpdateUserRoleResult,
  type DriftReview,
  type DriftAcceptResult,
  type DriftRejectResult,
  type ContactVerification,
  type ContactVerificationResult,
  type ImportUserRow,
  type ImportUserRowResult,
  type ImportUsersResult,
} from "./tenants.js";

export {
  RolesClient,
  OWNER,
  MEMBER,
  type Role,
  type PrincipalKind,
  type RoleObject,
  type RoleListPage,
  type RoleListOpts,
  type RoleCreate,
  type RolePatch,
  type Permission,
} from "./roles.js";

export {
  ScopesClient,
  type ScopeRenameRequest,
  type ScopeRenameResult,
} from "./scopes.js";

export {
  SigningKeysClient,
  type SigningKey,
  type SigningKeyRotation,
  type SigningKeysResponse,
  type RotateSigningKeyResult,
} from "./signing-keys.js";

export {
  ApiKeysClient,
  type ApiKey,
  type ApiKeyCreate,
} from "./api-keys.js";

// End-user API keys (ADR-084, SPEC §6.6) — `/tenants/{tid}/users/{uid}/user-api-keys`.
// Deliberately separate from ApiKeysClient above: different table, route segment,
// plaintext prefix (`uk_live_` vs `rk_live_`) and permission pair, so an org admin
// managing members' keys does not thereby gain platform-key power. Reused by
// @realm-id/web-admin as `admin.userApiKeys`.
export {
  UserApiKeysClient,
  capAllows,
  isUserApiKeyRevoked,
  type UserApiKey,
  type UserApiKeyWrite,
  type UserApiKeyCreate,
  type OrgScope,
  type LivePermissionResolver,
} from "./user-api-keys.js";

export {
  DomainsClient,
  type DomainClaim,
  type DomainVerifyResult,
} from "./domains.js";

export {
  AdminClient,
  type PlatformOwner,
  type PlatformSummary,
  type AdminPlatformsResponse,
  type AdminStats,
  type AuditEvent,
  type AdminEventsResponse,
  type SearchHit,
  type AdminSearchResponse,
  type ListPlatformsOpts,
  type ListEventsOpts,
} from "./admin.js";

export {
  OriginsClient,
  normalizeOrigin,
  type Origin,
  type OriginListOpts,
  type OriginValidateOpts,
} from "./origins.js";

// HttpClient is re-exported as both a value (for users who want to
// instantiate the stock client) and as a type for duck-typing against a
// custom transport. The web-admin SDK is expected to pass an object with
// a `.request()` method matching `HttpClient["request"]`.
export { HttpClient, type RequestOptions, type HttpClientOptions } from "./http.js";

// Service accounts (ADR-071) — kind=service identities managed by the
// owner/admin console over /tenants/{id}/service-accounts.
export {
  ServiceAccountsClient,
  type ServiceAccount,
  type ServiceAccountCreate,
  type ServiceAccountRevokeResult,
} from "./service-accounts.js";

// Sources (ADR-072) — platform-level app/source registry with per-source
// allowed_methods (mapping-2, gated by mapping-1).
export {
  SourcesClient,
  type Source,
  type SourceCreate,
  type SourcePatch,
} from "./sources.js";

// Cross-realm integrations (ADR-082/083) — source register/mint + target
// install. Reused by @realm-id/web-admin as `admin.integrations`.
export {
  IntegrationsClient,
  type Integration,
  type Installation,
  type IntegrationCreate,
  type IntegrationPatch,
  type InstallRequest,
  type InstallResult,
  type IntegrationMintRequest,
  type IntegrationMintResult,
  type IntegrationListPage,
  type InstallationListPage,
  type IntegrationListOpts,
} from "./integrations.js";

// OTP primitive (ADR-071 §4) — the admin console mints a `view_bff` login
// OTP for a service account and shows the plaintext value once.
export {
  OtpClient,
  DELIVERY_MODE_VIEW_BFF,
  type OtpDeliveryMode,
  type OtpIssueRequest,
  type OtpIssueResponse,
  type OtpViewResponse,
  type OtpVerifyRequest,
  type OtpVerifyResponse,
} from "./otp.js";
