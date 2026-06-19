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
} from "@realm-id/sdk/internal";

import { realmFetchAsHttpClient, type HttpLike } from "./transport.js";
import { ApiKeysClient } from "./api-keys.js";
import { PlatformsClient } from "./platforms.js";
import { PlatformNotesClient } from "./notes.js";
import { SigningKeysClient } from "./signing-keys.js";
import { BffClient } from "./bff.js";
import { SessionsClient } from "./sessions.js";
import { MeClient } from "./me.js";

export interface Admin {
  tenants: TenantsClient;
  roles: RolesClient;
  apiKeys: ApiKeysClient;
  domains: DomainsClient;
  admin: AdminClient;
  platforms: PlatformsClient;
  notes: PlatformNotesClient;
  signingKeys: SigningKeysClient;
  bff: BffClient;
  sessions: SessionsClient;
  me: MeClient;
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
    tenants: new TenantsClient(httpAsClient, rid),
    roles: new RolesClient(httpAsClient, rid),
    apiKeys: new ApiKeysClient(http),
    domains: new DomainsClient(httpAsClient),
    admin: new AdminClient(httpAsClient),
    platforms: new PlatformsClient(http),
    notes: new PlatformNotesClient(http),
    signingKeys: new SigningKeysClient(http),
    bff: new BffClient(http),
    sessions: new SessionsClient(http),
    me: new MeClient(http),
  };
}

export { realmFetchAsHttpClient } from "./transport.js";
export type { HttpLike, RealmFetchHttpOptions } from "./transport.js";

export { ApiKeysClient } from "./api-keys.js";
export { PlatformsClient } from "./platforms.js";
export type {
  PlatformCreate,
  PlatformApiKeyCreate,
  PlatformOwnerInvite,
} from "./platforms.js";
export { PlatformNotesClient } from "./notes.js";
export { SigningKeysClient } from "./signing-keys.js";
export { BffClient } from "./bff.js";
export { SessionsClient } from "./sessions.js";
export { MeClient } from "./me.js";

// Re-export the underlying resource clients for direct construction
// (advanced consumers who want to swap the transport).
export {
  TenantsClient,
  RolesClient,
  DomainsClient,
  AdminClient,
} from "@realm-id/sdk/internal";

// Wire types.
export type * from "./types.js";

// Convenience re-exports of resource-class types most UI consumers
// will pull from this package rather than @realm-id/sdk/internal.
export type {
  Tenant,
  TenantCreate,
  TenantPatch,
  Invitation,
  InvitationCreate,
  User,
  UserStatus,
  DriftReview,
  DriftAcceptResult,
  DriftRejectResult,
  ContactVerification,
  ContactVerificationResult,
  Role,
  RoleObject,
  RoleListPage,
  RoleListOpts,
  RoleCreate,
  RolePatch,
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
} from "@realm-id/sdk/internal";

export { RealmError } from "@realm-id/sdk";
export type { ErrorCode } from "@realm-id/sdk";
