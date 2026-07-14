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
} from "./types.js";

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

  async createTenant(
    platformId: string,
    input: { display_name: string },
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
