/**
 * @internal
 *
 * Internal entry point for sibling browser SDKs (e.g. `@realmid/web-admin`)
 * that need to construct the resource clients directly against a custom
 * transport. Not intended for partner consumption — use the top-level
 * `createRealm` facade exported from `@realmid/sdk` for that.
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
  type TenantPatch,
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
} from "./tenants.js";

export {
  RolesClient,
  OWNER,
  MEMBER,
  type Role,
  type RoleObject,
  type RoleListPage,
  type RoleListOpts,
  type RoleCreate,
  type RolePatch,
} from "./roles.js";

export {
  ApiKeysClient,
  type ApiKey,
  type ApiKeyCreate,
} from "./api-keys.js";

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
