/**
 * Identity-provider admin CRUD — issuer `/identity-providers` (ADR-046).
 *
 * A platform admin configures the OAuth `client_id` per provider, scoped
 * either realm-wide (`tenant_id` omitted) or to a single tenant. RealmID
 * stores **only** the public `client_id` — there is no `client_secret`
 * field anywhere, by design.
 *
 * ROUTING NOTE: these are *issuer* routes (owner/realm-admin gated) that
 * share the `/identity-providers` path with the BFF's *public* lookup
 * (`GET`, platform-token authed, returns only `{type, client_type,
 * client_id}`). The admin transport special-cases `/identity-providers`
 * as BFF-direct for that public path, so every call here sets
 * `x-realmid-via: api` to force the `/api` passthrough to the issuer
 * (carrying the caller's owner session). The header is stripped before
 * the request reaches the wire.
 */

import type { HttpLike } from "./transport.js";
import type {
  AdminIdentityProvider,
  IdpCreateInput,
  IdpListPage,
  IdpPatchInput,
} from "./types.js";

/** Forces the `/api` passthrough — see the routing note above. */
const VIA_PASSTHROUGH: Record<string, string> = { "x-realmid-via": "api" };

function normalizeList(raw: unknown): AdminIdentityProvider[] {
  if (Array.isArray(raw)) return raw as AdminIdentityProvider[];
  const page = raw as IdpListPage | null | undefined;
  return page?.items ?? [];
}

export class IdentityProvidersClient {
  constructor(private readonly http: HttpLike) {}

  /**
   * List configured providers for a realm. Pass `tenantId` to list a
   * tenant's overrides instead of the realm-wide rows. Returns active
   * **and** disabled rows (each carries an `enabled` flag).
   */
  async list(
    platformId: string,
    opts: { tenantId?: string } = {},
  ): Promise<AdminIdentityProvider[]> {
    const raw = await this.http.request<unknown>({
      method: "GET",
      path: "/identity-providers",
      query: { platform_id: platformId, tenant_id: opts.tenantId },
      headers: VIA_PASSTHROUGH,
    });
    return normalizeList(raw);
  }

  /** Create a provider row (realm- or tenant-scoped per `tenant_id`). */
  async create(input: IdpCreateInput): Promise<AdminIdentityProvider> {
    return this.http.request<AdminIdentityProvider>({
      method: "POST",
      path: "/identity-providers",
      body: input,
      headers: VIA_PASSTHROUGH,
    });
  }

  /** Sparse update (enabled / client_id / allowed_origins / comments). */
  async update(
    id: string,
    patch: IdpPatchInput,
  ): Promise<AdminIdentityProvider> {
    return this.http.request<AdminIdentityProvider>({
      method: "PATCH",
      path: `/identity-providers/${encodeURIComponent(id)}`,
      body: patch,
      headers: VIA_PASSTHROUGH,
    });
  }

  /** Hard-delete a provider row. */
  async remove(id: string): Promise<void> {
    await this.http.request<void>({
      method: "DELETE",
      path: `/identity-providers/${encodeURIComponent(id)}`,
      headers: VIA_PASSTHROUGH,
    });
  }
}
