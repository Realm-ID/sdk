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
import type { RoleObject, TenantOwner } from "@realm-id/sdk/internal";

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
  /**
   * Opt into RealmID's starter role templates (issuer v0.54.0). Omit — or send
   * `[]` — and the realm is created with only the three system roles
   * (`owner`, `member`, `platform_api`).
   *
   * Before v0.54.0 `admin` and `viewer` were seeded unconditionally, which gave
   * every realm a 23-permission operator role it never asked for. An unknown
   * name is rejected with 400 `unknown_starter_role`.
   */
  starter_roles?: StarterRole[];
}

/** The role templates RealmID offers; see {@link PlatformCreate.starter_roles}. */
export type StarterRole = "admin" | "viewer";

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

  /**
   * Opt into RealmID's starter role templates after the platform already
   * exists (issuer v0.54.0) — the post-creation counterpart of
   * {@link PlatformCreate.starter_roles}. Creates `admin`/`viewer` pre-filled
   * with their permission sets instead of authoring them by hand.
   *
   * Idempotent and never destructive: seeding is ON CONFLICT DO NOTHING, so a
   * name the realm already holds — including a role the partner authored that
   * happens to be called `admin` — is left untouched with its own permissions.
   * The response echoes the rows now present under the requested names, so the
   * caller can see whether an existing role was preserved.
   *
   * Requires `roles:manage`.
   */
  async seedStarterRoles(
    platformId: string,
    starterRoles: StarterRole[],
  ): Promise<RoleObject[]> {
    return this.http.request<RoleObject[]>({
      method: "POST",
      path: `/platforms/${encodeURIComponent(platformId)}/starter-roles`,
      body: { starter_roles: starterRoles },
    });
  }

  async listMine(): Promise<Platform[]> {
    const d = await this.http.request<{ items: Platform[] }>({
      method: "GET",
      path: "/platforms/mine",
    });
    return d.items;
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
