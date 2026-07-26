/**
 * @realm-id/web-admin — admin-UI SDK companion to @realm-id/web.
 *
 * Reuses the resource classes from @realm-id/sdk/internal on top of a
 * thin transport shim that delegates to `realm.fetch`. SDK ownership
 * of Authorization-attach, refresh-on-401, and multi-tab logout sync
 * applies to every admin call.
 *
 * Quick start:
 *
 *   import { createRealm } from "@realm-id/web";
 *   import { createAdmin } from "@realm-id/web-admin";
 *
 *   const realm = createRealm({ baseUrl: "https://api.partner.com" });
 *   const admin = createAdmin(realm, { baseUrl: "https://api.partner.com" });
 *   const tenants = await admin.tenants.list();
 */

import type { Realm } from "@realm-id/web";
import {
  TenantsClient,
  RolesClient,
  DomainsClient,
  AdminClient,
  SigningKeysClient as OwnerSigningKeysClient,
  ServiceAccountsClient,
  SourcesClient,
  IntegrationsClient,
  OtpClient,
  UserApiKeysClient,
} from "@realm-id/sdk/internal";

import { realmFetchAsHttpClient, type HttpLike } from "./transport.js";
import { ApiKeysClient } from "./api-keys.js";
import { IdentityProvidersClient } from "./identity-providers.js";
import { PlatformsClient } from "./platforms.js";
import { OriginsClient } from "./origins.js";
import { PlatformNotesClient } from "./notes.js";
import { SigningKeysClient } from "./signing-keys.js";
import { BffClient } from "./bff.js";
import { SessionsClient } from "./sessions.js";
import { MeClient } from "./me.js";
import { MfaClient } from "./mfa.js";
import { AdminTenantsClient } from "./tenants.js";

export interface Admin {
  /** Tenants + nested users/invitations/driftReviews. The `users` and
   *  `driftReviews` sub-clients carry the ADR-080 delink / hand-back /
   *  hard-reject ops (see {@link AdminTenantsClient}). */
  tenants: AdminTenantsClient;
  roles: RolesClient;
  apiKeys: ApiKeysClient;
  identityProviders: IdentityProvidersClient;
  domains: DomainsClient;
  admin: AdminClient;
  platforms: PlatformsClient;
  /** Realm SPA origins / custom domains (ADR-049) — attach a custom apex
   *  to an existing platform via the claim → verify → bind flow. */
  origins: OriginsClient;
  notes: PlatformNotesClient;
  signingKeys: SigningKeysClient;
  /** Owner-facing signing-key read + self-serve rotate (/platforms/{id}/signing-keys). */
  keys: OwnerSigningKeysClient;
  /** Service accounts (ADR-071) — kind=service identities per tenant. */
  serviceAccounts: ServiceAccountsClient;
  /** Cross-realm integrations (ADR-082/083): source register/mint + target install. */
  integrations: IntegrationsClient;
  /** Platform app/source registry (ADR-072). Bound to the admin's realmId. */
  sources: SourcesClient;
  /** OTP primitive (ADR-071 §4) — mint a `view_bff` service-account login OTP. */
  otp: OtpClient;
  /**
   * End-user API keys (ADR-084) — `uk_live_…` credentials a member mints for
   * themselves, or an org admin views. NOT `apiKeys`: that is the platform
   * (`rk_live_…`) surface, and the split is deliberate so managing members' keys
   * confers no platform-key power.
   */
  userApiKeys: UserApiKeysClient;
  bff: BffClient;
  /** Session revocation — self (`revoke`/`revokeAll`) + admin
   *  (`revokeUser`/`revokeRealmSessions`, ADR-080). */
  sessions: SessionsClient;
  me: MeClient;
  /** Self-service MFA reads/ops for the signed-in admin (ADR-080). */
  mfa: MfaClient;
}

export interface CreateAdminOptions {
  /** Absolute base URL of the BFF; required because `Realm` doesn't
   *  expose its own `baseUrl` on the public surface. */
  baseUrl: string;
  /** Override the `/api` passthrough prefix. Default `/api`. */
  apiPrefix?: string;
  /**
   * The current realm/platform id used to construct paths in the
   * resource classes (`/platforms/{id}/...`). Defaults to `"current"`
   * — many UIs operate on the caller's session-implied platform and
   * the BFF rewrites the path; pass an explicit id when targeting
   * another platform.
   */
  realmId?: string;
}

export function createAdmin(realm: Realm, opts: CreateAdminOptions): Admin {
  const http: HttpLike = realmFetchAsHttpClient(realm, {
    baseUrl: opts.baseUrl,
    apiPrefix: opts.apiPrefix,
  });
  const rid = opts.realmId ?? "current";
  // Cast: TenantsClient/RolesClient/etc. accept the real `HttpClient`
  // from `@realm-id/sdk/internal`, but only call `.request<T>()` — the
  // duck-typed `HttpLike` satisfies that surface. The cast is the
  // boundary between the resource classes' nominal type and our
  // structural shim.
  const httpAsClient = http as unknown as ConstructorParameters<typeof TenantsClient>[0];

  return {
    tenants: new AdminTenantsClient(httpAsClient, rid),
    roles: new RolesClient(httpAsClient, rid),
    apiKeys: new ApiKeysClient(http),
    identityProviders: new IdentityProvidersClient(http),
    domains: new DomainsClient(httpAsClient),
    admin: new AdminClient(httpAsClient),
    platforms: new PlatformsClient(http),
    origins: new OriginsClient(http),
    notes: new PlatformNotesClient(http),
    signingKeys: new SigningKeysClient(http),
    keys: new OwnerSigningKeysClient(httpAsClient, rid),
    serviceAccounts: new ServiceAccountsClient(httpAsClient),
    sources: new SourcesClient(httpAsClient, rid),
    integrations: new IntegrationsClient(httpAsClient, rid),
    otp: new OtpClient(httpAsClient),
    userApiKeys: new UserApiKeysClient(httpAsClient),
    bff: new BffClient(http),
    sessions: new SessionsClient(http),
    me: new MeClient(http),
    mfa: new MfaClient(http),
  };
}

export { realmFetchAsHttpClient } from "./transport.js";
export type { HttpLike, RealmFetchHttpOptions } from "./transport.js";

export { ApiKeysClient } from "./api-keys.js";
export { IdentityProvidersClient } from "./identity-providers.js";
export { PlatformsClient } from "./platforms.js";
export type {
  PlatformCreate,
  PlatformApiKeyCreate,
  PlatformOwnerInvite,
  StarterRole,
} from "./platforms.js";
export { OriginsClient } from "./origins.js";
export { PlatformNotesClient } from "./notes.js";
export { SigningKeysClient } from "./signing-keys.js";
export { BffClient } from "./bff.js";
export { SessionsClient } from "./sessions.js";
export { MeClient } from "./me.js";
export { MfaClient } from "./mfa.js";
export { AdminTenantsClient } from "./tenants.js";
export { AdminUsersClient, AdminDriftReviewsClient } from "./user-binding.js";
export { CONTACT_ADMIN_REQUIRED, isContactAdminRequired } from "./errors.js";

// Re-export the underlying resource clients for direct construction
// (advanced consumers who want to swap the transport).
export {
  TenantsClient,
  RolesClient,
  DomainsClient,
  AdminClient,
  ServiceAccountsClient,
  SourcesClient,
  IntegrationsClient,
  OtpClient,
  UserApiKeysClient,
  capAllows,
  isUserApiKeyRevoked,
  DELIVERY_MODE_VIEW_BFF,
} from "@realm-id/sdk/internal";

// Wire types.
export type * from "./types.js";

// Convenience re-exports of resource-class types most UI consumers
// will pull from this package rather than @realm-id/sdk/internal.
export type {
  Tenant,
  TenantCreate,
  TenantPatch,
  TenantConfigPatch,
  Invitation,
  InvitationCreate,
  User,
  UserStatus,
  DriftReview,
  DriftAcceptResult,
  ContactVerification,
  ContactVerificationResult,
  Role,
  RoleObject,
  RoleListPage,
  RoleListOpts,
  RoleCreate,
  RolePatch,
  Permission,
  SigningKey,
  SigningKeyRotation,
  SigningKeysResponse,
  RotateSigningKeyResult,
  DomainClaim,
  DomainVerifyResult,
  PlatformOwner,
  PlatformSummary,
  AdminPlatformsResponse as AdminPlatformsAggregate,
  AdminStats as AdminStatsAggregate,
  AuditEvent,
  AdminEventsResponse as AdminEventsAggregate,
  SearchHit,
  AdminSearchResponse,
  ListPlatformsOpts,
  ListEventsOpts,
  ServiceAccount,
  ServiceAccountCreate,
  ServiceAccountRevokeResult,
  Source,
  SourceCreate,
  SourcePatch,
  OtpDeliveryMode,
  OtpIssueRequest,
  OtpIssueResponse,
  OtpViewResponse,
  OtpVerifyRequest,
  OtpVerifyResponse,
  ImportUserRow,
  ImportUserRowResult,
  ImportUsersResult,
  UserApiKey,
  UserApiKeyCreate,
  OrgScope,
  LivePermissionResolver,
} from "@realm-id/sdk/internal";

export { RealmError } from "@realm-id/sdk";
export type { ErrorCode } from "@realm-id/sdk";
