/**
 * Identity-provider config CRUD — realm-admin resource client.
 *
 * This is the ADMIN management surface for social/OIDC provider configs
 * (Google, Microsoft, Facebook, Apple). It is DISTINCT from the public
 * IdP discovery surface; do not conflate the two.
 *
 * Authorization is the short-lived platform token, injected automatically
 * by the HttpClient (same model as `roles`). `platform_id` is required by
 * the server but is ALWAYS the realm's own id, so the SDK injects it
 * automatically — callers never pass it. An optional `tenantId` scopes a
 * provider to a single tenant within the realm.
 */

import type { HttpClient } from "./http.js";

export type IdpEntityType = "realm" | "tenant";
export type IdpProvider = "google" | "microsoft" | "facebook" | "apple";
export type IdpClientType = "web" | "ios" | "android" | "desktop" | "other";

export interface IdpConfig {
  id: string;
  entity_type: IdpEntityType;
  entity_id: string;
  provider: IdpProvider;
  client_type: IdpClientType;
  client_id: string;
  allowed_origins: string[];
  comments: string;
  /**
   * Provider-specific PUBLIC config (never secrets) — e.g. the Firebase
   * web config (`apiKey`, `authDomain`, `projectId`, `appId`). Echoed
   * verbatim on public discovery so a browser SDK can bootstrap sign-in.
   * Absent when empty.
   */
  config?: Record<string, string>;
  enabled: boolean;
  created_at: number;
  updated_at: number;
  [k: string]: unknown;
}

export interface IdpConfigListPage {
  items: IdpConfig[];
}

export interface IdpConfigListOpts {
  /** Scope the listing to a single tenant within the realm. */
  tenantId?: string;
}

export interface IdpConfigCreate {
  /** Optional tenant scope; omit for a realm-level provider. */
  tenantId?: string;
  provider: IdpProvider;
  clientType: IdpClientType;
  clientId: string;
  /**
   * Required (non-empty) when `clientType === "web"`; must be absent/empty
   * otherwise. The server enforces this; the SDK passes it through.
   */
  allowedOrigins?: string[];
  comments?: string;
  /**
   * Provider-specific PUBLIC config (never secrets) — e.g. the Firebase
   * web config (`apiKey`, `authDomain`, `projectId`, `appId`). Echoed
   * verbatim on public discovery. Omit for plain OIDC.
   */
  config?: Record<string, string>;
}

export interface IdpConfigPatch {
  enabled?: boolean;
  clientId?: string;
  allowedOrigins?: string[];
  comments?: string;
  /**
   * When set, REPLACES the stored provider config map wholesale (not
   * merged). Publishable values only — never secrets.
   */
  config?: Record<string, string>;
}

export class IdentityProviderConfigClient {
  constructor(
    private readonly http: HttpClient,
    private readonly realmId: string,
  ) {}

  /**
   * GET /identity-providers?platform_id={realmId}[&tenant_id=...].
   * Returns one page; a nil/absent `items` is normalized to an empty list
   * (matching `roles.list`).
   */
  async list(opts?: IdpConfigListOpts): Promise<IdpConfigListPage> {
    const raw = await this.http.request<unknown>({
      method: "GET",
      path: "/identity-providers",
      query: { platform_id: this.realmId, tenant_id: opts?.tenantId },
    });
    return normalizePage(raw);
  }

  /**
   * POST /identity-providers. `platform_id` is injected as the realm id.
   */
  async create(body: IdpConfigCreate): Promise<IdpConfig> {
    const wire: Record<string, unknown> = {
      platform_id: this.realmId,
      provider: body.provider,
      client_type: body.clientType,
      client_id: body.clientId,
    };
    if (body.tenantId !== undefined) wire["tenant_id"] = body.tenantId;
    if (body.allowedOrigins !== undefined) wire["allowed_origins"] = body.allowedOrigins;
    if (body.comments !== undefined) wire["comments"] = body.comments;
    if (body.config !== undefined) wire["config"] = body.config;
    return this.http.request<IdpConfig>({
      method: "POST",
      path: "/identity-providers",
      body: wire,
    });
  }

  /**
   * PATCH /identity-providers/{id}. Only set fields are sent; the server
   * returns `empty_patch` when nothing is provided.
   */
  async update(id: string, patch: IdpConfigPatch): Promise<IdpConfig> {
    const wire: Record<string, unknown> = {};
    if (patch.enabled !== undefined) wire["enabled"] = patch.enabled;
    if (patch.clientId !== undefined) wire["client_id"] = patch.clientId;
    if (patch.allowedOrigins !== undefined) wire["allowed_origins"] = patch.allowedOrigins;
    if (patch.comments !== undefined) wire["comments"] = patch.comments;
    if (patch.config !== undefined) wire["config"] = patch.config;
    return this.http.request<IdpConfig>({
      method: "PATCH",
      path: `/identity-providers/${encodeURIComponent(id)}`,
      body: wire,
    });
  }

  /** DELETE /identity-providers/{id}. Returns the deleted ack. */
  async delete(id: string): Promise<{ status: "deleted" }> {
    const out = await this.http.request<{ status?: string } | undefined>({
      method: "DELETE",
      path: `/identity-providers/${encodeURIComponent(id)}`,
    });
    return { status: (out?.status as "deleted") ?? "deleted" };
  }
}

function normalizePage(raw: unknown): IdpConfigListPage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { items: [] };
  }
  const obj = raw as Record<string, unknown>;
  const items = Array.isArray(obj["items"]) ? (obj["items"] as IdpConfig[]) : [];
  return { items };
}
