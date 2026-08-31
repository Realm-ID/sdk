/**
 * Cross-realm integrations — `realm.integrations.*` (ADR-082 / ADR-083).
 *
 * A SOURCE platform publishes an integration; a TARGET org installs it,
 * admitting a `kind=service` principal into the org that holds a chosen
 * service-typed role; the source platform then MINTS short-lived target-realm
 * access tokens against the installation. GitHub-App-shaped. RI hosts no
 * consent screen — this surface IS the consent surface (ADR-083 §5).
 *
 * The SDK is per-realm: register/mint run on the SOURCE realm's client,
 * install/uninstall run on the TARGET realm's client. The source-side methods
 * take no platform id (baked in, like `realm.roles.*`).
 *
 * Server error codes surface on `RealmError.code`: `slug_taken` (409),
 * `already_installed` (409), `permissions_required` / `unknown_permission`
 * (400), `permissions_exceed_grantor` (403), `integration_not_found` /
 * `installation_not_found` (404), `installation_revoked` / `role_unavailable`
 * (403), `key_class_mismatch` (401). `role_not_service_typed` /
 * `role_not_installable` are retained in the taxonomy but DEAD — the issuer
 * has emitted neither since ADR-101 D7.
 */

import type { HttpClient } from "./http.js";

/** A source platform's published integration. */
export interface Integration {
  id: string;
  realm_id: string;
  slug: string;
  display_name: string;
  description: string;
  homepage_url: string;
  listed: boolean;
  disabled: boolean;
  created_at: string;
  updated_at: string;
  [k: string]: unknown;
}

/** One inbound edge in a target org's access list (ADR-083 §4.5). */
export interface Installation {
  id: string;
  integration_id: string;
  source_realm_id: string;
  integration_slug: string;
  integration_display_name: string;
  /**
   * The ADR-101 D7 stated grant — what the brokered principal may do. It
   * REPLACED `role_id`/`role_name`, which named a role and inherited whatever
   * that role happened to grant that day.
   */
  permissions: string[];
  principal_user_id: string;
  approved_by_user_id: string | null;
  approved_at: string;
  last_used_at: string | null;
  mint_count: number;
  [k: string]: unknown;
}

/** POST /platforms/{id}/integrations body. */
export interface IntegrationCreate {
  slug: string;
  displayName: string;
  description?: string;
  homepageUrl?: string;
  listed?: boolean;
}

/** PATCH /platforms/{id}/integrations/{iid} body. Omitted keys are untouched. */
export interface IntegrationPatch {
  displayName?: string;
  description?: string;
  homepageUrl?: string;
  listed?: boolean;
}

/**
 * POST /tenants/{id}/integration-installations body.
 *
 * `permissions` is the ADR-101 D7 STATED grant: the ADR-074 catalog
 * permissions this integration may exercise in the target org. It replaced
 * `roleId`, which named a role and silently inherited whatever that role
 * granted today.
 *
 * Required and non-empty — an install granting nothing can authorise no call,
 * and ADR-100's lesson is that an empty authority field acquires a meaning
 * nobody chose. Empty is `permissions_required`, not an install that enforces
 * nothing. Every entry must be a real catalog permission
 * (`unknown_permission`), and you cannot grant authority you do not hold
 * (`permissions_exceed_grantor`).
 */
export interface InstallRequest {
  integrationId: string;
  permissions: string[];
}

/** Install acknowledgment. */
export interface InstallResult {
  id: string;
  integration_id: string;
  permissions: string[];
  principal_user_id: string;
  status: string;
  [k: string]: unknown;
}

/**
 * Input to `mintToken`. `apiKey` is the SOURCE platform's raw `platform_api`
 * key (never a user/session token). `sourceOrgId` is required and stamped into
 * the token + target-org audit, but is caller-asserted (ADR-082 §7.6).
 */
export interface IntegrationMintRequest {
  apiKey: string;
  installationId: string;
  sourceOrgId: string;
}

/**
 * Brokered token. There is NO refresh token — the token cannot be renewed, so
 * re-mint as expiry nears. `expires_in` is a fixed 600 s (ADR-083 §4.3).
 */
export interface IntegrationMintResult {
  access_token: string;
  expires_in: number;
  tenant_id: string;
  role: string;
  [k: string]: unknown;
}

/** One page of integrations / installations (locked SPEC §7 envelope). */
export interface IntegrationListPage {
  items: Integration[];
  next_cursor: string | null;
}
export interface InstallationListPage {
  items: Installation[];
  next_cursor: string | null;
}

/** Optional pagination inputs shared by the list surfaces. */
export interface IntegrationListOpts {
  cursor?: string;
  limit?: number;
}

function integrationPage(raw: unknown): IntegrationListPage {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const items = Array.isArray(obj["items"]) ? (obj["items"] as Integration[]) : [];
  const nc = obj["next_cursor"];
  return { items, next_cursor: typeof nc === "string" ? nc : null };
}
function installationPage(raw: unknown): InstallationListPage {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const items = Array.isArray(obj["items"]) ? (obj["items"] as Installation[]) : [];
  const nc = obj["next_cursor"];
  return { items, next_cursor: typeof nc === "string" ? nc : null };
}

export class IntegrationsClient {
  constructor(
    private readonly http: HttpClient,
    private readonly realmId: string,
  ) {}

  private sourceBase(): string {
    return `/platforms/${encodeURIComponent(this.realmId)}/integrations`;
  }
  private targetBase(tenantId: string): string {
    return `/tenants/${encodeURIComponent(tenantId)}/integration-installations`;
  }

  // ---- source side ----

  /** POST /platforms/{id}/integrations — publish a new integration. */
  async register(body: IntegrationCreate): Promise<Integration> {
    const wire: Record<string, unknown> = { slug: body.slug, display_name: body.displayName };
    if (body.description !== undefined) wire["description"] = body.description;
    if (body.homepageUrl !== undefined) wire["homepage_url"] = body.homepageUrl;
    if (body.listed !== undefined) wire["listed"] = body.listed;
    return this.http.request<Integration>({ method: "POST", path: this.sourceBase(), body: wire });
  }

  /** GET /platforms/{id}/integrations — one page of published integrations. */
  async list(opts?: IntegrationListOpts): Promise<IntegrationListPage> {
    const raw = await this.http.request<unknown>({
      method: "GET",
      path: this.sourceBase(),
      query: { cursor: opts?.cursor, limit: opts?.limit },
    });
    return integrationPage(raw);
  }

  /** PATCH /platforms/{id}/integrations/{iid} — edit display fields / listed. */
  async update(id: string, patch: IntegrationPatch): Promise<Integration> {
    const wire: Record<string, unknown> = {};
    if (patch.displayName !== undefined) wire["display_name"] = patch.displayName;
    if (patch.description !== undefined) wire["description"] = patch.description;
    if (patch.homepageUrl !== undefined) wire["homepage_url"] = patch.homepageUrl;
    if (patch.listed !== undefined) wire["listed"] = patch.listed;
    return this.http.request<Integration>({
      method: "PATCH",
      path: `${this.sourceBase()}/${encodeURIComponent(id)}`,
      body: wire,
    });
  }

  /** POST …/{iid}/disable — reversible halt of every mint. */
  async disable(id: string): Promise<void> {
    await this.http.request<unknown>({
      method: "POST",
      path: `${this.sourceBase()}/${encodeURIComponent(id)}/disable`,
    });
  }

  /** POST …/{iid}/enable — re-enable a disabled integration. */
  async enable(id: string): Promise<void> {
    await this.http.request<unknown>({
      method: "POST",
      path: `${this.sourceBase()}/${encodeURIComponent(id)}/enable`,
    });
  }

  /**
   * DELETE /platforms/{id}/integrations/{iid} — permanent disable (the source
   * half of two-ended revocation). NOT a cascade delete; target orgs' inbound
   * history survives (ADR-083 §9).
   */
  async remove(id: string): Promise<void> {
    await this.http.request<unknown>({
      method: "DELETE",
      path: `${this.sourceBase()}/${encodeURIComponent(id)}`,
    });
  }

  // ---- target side ----

  /**
   * POST /tenants/{id}/integration-installations — admit a foreign integration,
   * granting it exactly the permissions `body.permissions` names (ADR-101 D7).
   */
  async install(tenantId: string, body: InstallRequest): Promise<InstallResult> {
    return this.http.request<InstallResult>({
      method: "POST",
      path: this.targetBase(tenantId),
      body: { integration_id: body.integrationId, permissions: body.permissions },
    });
  }

  /**
   * GET /tenants/{id}/integration-installations — the inbound-access list. A
   * non-zero count after an ownership transfer is foreign access the new owner
   * never approved (ADR-082 §7.4) — surface it.
   */
  async listInstallations(tenantId: string, opts?: IntegrationListOpts): Promise<InstallationListPage> {
    const raw = await this.http.request<unknown>({
      method: "GET",
      path: this.targetBase(tenantId),
      query: { cursor: opts?.cursor, limit: opts?.limit },
    });
    return installationPage(raw);
  }

  /**
   * DELETE /tenants/{id}/integration-installations/{iid} — revoke an inbound
   * edge. Future mints fail; live access tokens are NOT revoked (bounded by the
   * 600 s TTL, ADR-083 §4.4).
   */
  async uninstall(tenantId: string, installationId: string): Promise<void> {
    await this.http.request<unknown>({
      method: "DELETE",
      path: `${this.targetBase(tenantId)}/${encodeURIComponent(installationId)}`,
    });
  }

  // ---- mint ----

  /**
   * Mint a brokered target-realm access token against an installation,
   * authenticated by the SOURCE platform's raw `platform_api` key (NOT a
   * user/session token). Returns an access token only — no refresh — so re-mint
   * as expiry nears. `skipPlatformToken` keeps the SDK's own platform bearer
   * off this call: the raw `apiKey` in the body IS the credential.
   */
  async mintToken(req: IntegrationMintRequest): Promise<IntegrationMintResult> {
    return this.http.request<IntegrationMintResult>({
      method: "POST",
      path: "/auth/login",
      skipPlatformToken: true,
      body: {
        grant_type: "integration_installation",
        api_key: req.apiKey,
        installation_id: req.installationId,
        source_org_id: req.sourceOrgId,
      },
    });
  }
}
