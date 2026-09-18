/**
 * Platforms CRUD — not currently in `sdk/ts/` because partner SDK
 * consumers don't manage their own platforms. Wraps the
 * passthrough-routed `/platforms/*` surface. Paths mirror
 * `ui/web/src/api.ts:706-849`.
 */

import type { HttpLike } from "./transport.js";
import type {
  Platform,
  PlatformCreatedResponse,
  TenantSummary,
  CreateApiKeyResponse,
  InvitationSummary,
  DomainClaimResponse,
  PendingDomain,
  PlatformStats,
  RealmConfigPatch,
  RealmConfigResponse,
} from "./types.js";
import type { TenantOwner } from "@realm-id/sdk/internal";

export interface PlatformCreate {
  /**
   * Optional custom apex (ADR-073 Release A). Omit to create a domainless
   * platform whose routing domain is `<slug>.realmid.dev`; a custom domain
   * can be added later via the realm-origins claim/verify flow.
   */
  domain?: string;
  /**
   * URL-safe globally-unique identifier; derives the `<slug>.realmid.dev`
   * hosted-login surface. Required by the issuer.
   */
  slug?: string;
  display_name?: string;
  // `starter_roles` is GONE (ADR-101, issuer v0.113.0). RealmID owns the role
  // set: `admin` is part of the floor every realm receives and `viewer` no
  // longer exists, so there is nothing left to opt into. The issuer answers
  // `400 starter_roles_retired` for ANY non-empty value, which means the field
  // could not be sent successfully — it was not merely ignored. To run a realm
  // without an admin role, disable it:
  // `POST /platforms/{id}/roles/{roleId}/disable`.
}

export interface PlatformApiKeyCreate {
  scope: string;
  label?: string;
}

export interface PlatformOwnerInvite {
  email: string;
  role?: string;
}

export class PlatformsClient {
  constructor(private readonly http: HttpLike) {}

  async create(input: PlatformCreate): Promise<PlatformCreatedResponse> {
    return this.http.request<PlatformCreatedResponse>({
      method: "POST",
      path: "/platforms",
      body: input,
    });
  }

  // `seedStarterRoles()` is GONE (ADR-101, issuer v0.113.0). The route
  // `POST /platforms/{id}/starter-roles` was DELETED, not deprecated — the
  // issuer answers 404 — so every call this method could make was a 404. The
  // replacement is the RI-owned `role_templates` vocabulary; a realm receives
  // the set, it does not opt into parts of it.

  async listMine(): Promise<Platform[]> {
    const d = await this.http.request<{ items: Platform[] }>({
      method: "GET",
      path: "/platforms/mine",
    });
    return d.items;
  }

  /**
   * GET /platforms/{id} — read one platform the caller owns (issuer v0.87.0,
   * spec 0.24.0). The singular counterpart of {@link listMine}, returning the
   * same row shape for one platform.
   *
   * Authorization is INHERITED from `/platforms/mine`, not restated: the
   * visible set is exactly what that endpoint returns, filtered to one id. So
   * an M2M platform key works here, which is the point — it is the read the
   * CLI's `platforms describe` needs.
   *
   * A platform the caller may not see returns the SAME `404
   * platform_not_found` as an id that was never issued — never `403`. Do not
   * render it as "you don't have access to this platform": that string is
   * itself the oracle the identical 404 exists to close.
   */
  async get(platformId: string): Promise<Platform> {
    return this.http.request<Platform>({
      method: "GET",
      path: `/platforms/${encodeURIComponent(platformId)}`,
    });
  }

  async rename(platformId: string, displayName: string): Promise<Platform> {
    return this.http.request<Platform>({
      method: "PATCH",
      path: `/platforms/${encodeURIComponent(platformId)}`,
      body: { display_name: displayName },
    });
  }

  async listTenants(platformId: string): Promise<TenantSummary[]> {
    const d = await this.http.request<{ items: TenantSummary[] }>({
      method: "GET",
      path: `/platforms/${encodeURIComponent(platformId)}/tenants`,
    });
    return d.items;
  }

  /**
   * GET /platforms/{id}/stats — the platform KPI rollup (orgs, users,
   * human sign-ins in the trailing 24h, MFA coverage). Gated on the ADR-074
   * `users:read` permission; server-cached 30s.
   */
  async stats(platformId: string): Promise<PlatformStats> {
    return this.http.request<PlatformStats>({
      method: "GET",
      path: `/platforms/${encodeURIComponent(platformId)}/stats`,
    });
  }

  /**
   * GET /platforms/{id}/config — the read counterpart of {@link updateConfig}
   * (issuer v0.52.0). Same `platform:config` gate as the PATCH: anyone who may
   * change the config may read it, nobody else.
   *
   * Every allowlist key is present in the response; a zero value means "unset"
   * (see {@link RealmConfigView}). Returns the config object alone — the
   * envelope's `id` is the platform id the caller already passed in.
   */
  async getConfig(platformId: string): Promise<RealmConfigResponse["config"]> {
    const resp = await this.http.request<RealmConfigResponse>({
      method: "GET",
      path: `/platforms/${encodeURIComponent(platformId)}/config`,
    });
    return resp.config;
  }

  /**
   * PATCH /platforms/{id}/config — partial update of the allowlisted
   * realm-config keys. Unknown keys are rejected server-side with a 400, and
   * out-of-range values with `invalid_config_value`.
   */
  async updateConfig(
    platformId: string,
    patch: RealmConfigPatch,
  ): Promise<RealmConfigResponse> {
    return this.http.request<RealmConfigResponse>({
      method: "PATCH",
      path: `/platforms/${encodeURIComponent(platformId)}/config`,
      body: patch,
    });
  }

  /**
   * POST /platforms/{id}/tenants — create an organization inside a platform
   * realm, seating its owner in the same transaction.
   *
   * Since issuer v0.59.0 (ADR-073 Amendment C) `tenants.owner_user_id` is NOT
   * NULL, so `owner` is REQUIRED — the type enforces it at compile time and the
   * server returns `owner_required` if it's ever absent. `id` (BYO UUID for an
   * idempotent reconcile) and `created_at` (backfilled origin timestamp) are the
   * optional bulk-migration passthroughs; omit both for an ordinary create.
   */
  async createTenant(
    platformId: string,
    input: {
      display_name: string;
      owner: TenantOwner;
      id?: string;
      created_at?: string;
    },
  ): Promise<TenantSummary> {
    return this.http.request<TenantSummary>({
      method: "POST",
      path: `/platforms/${encodeURIComponent(platformId)}/tenants`,
      body: input,
    });
  }

  async createApiKey(
    platformId: string,
    input: PlatformApiKeyCreate,
  ): Promise<CreateApiKeyResponse> {
    return this.http.request<CreateApiKeyResponse>({
      method: "POST",
      path: `/platforms/${encodeURIComponent(platformId)}/api-keys`,
      body: input,
    });
  }

  async invitePlatformOwner(
    platformId: string,
    tenantId: string,
    input: PlatformOwnerInvite,
  ): Promise<InvitationSummary> {
    return this.http.request<InvitationSummary>({
      method: "POST",
      path: `/platforms/${encodeURIComponent(platformId)}/tenants/${encodeURIComponent(tenantId)}/invitations`,
      body: { role: "owner", ...input },
    });
  }

  async claimDomain(input: { domain: string }): Promise<DomainClaimResponse> {
    return this.http.request<DomainClaimResponse>({
      method: "POST",
      path: "/domains/claim",
      body: input,
    });
  }

  async verifyDomain(input: { domain: string }): Promise<{ status: string }> {
    return this.http.request<{ status: string }>({
      method: "POST",
      path: "/domains/verify",
      body: input,
    });
  }

  /**
   * GET /domains/pending — the caller's non-expired in-progress domain
   * verifications, so a UI can resume one after a refresh dropped the
   * client-side claim state. Each row carries the same TXT record the
   * original claim returned.
   */
  async listPendingDomains(): Promise<PendingDomain[]> {
    const resp = await this.http.request<{ items?: PendingDomain[] }>({
      method: "GET",
      path: "/domains/pending",
    });
    return resp?.items ?? [];
  }
}
