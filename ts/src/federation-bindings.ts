/**
 * Workload-identity federation trust bindings (ADR-057). CRUD over
 * `/platforms/{id}/federation-bindings`. A workload OIDC assertion is accepted
 * as a bootstrap credential for this platform iff its `iss` matches `issuer`,
 * its `aud` matches `audience`, and every `match_claims` entry equals the
 * corresponding assertion claim.
 */

import type { HttpClient } from "./http.js";
import { paginate, readPage, type Paginated, type PageOpts } from "./pagination.js";

export interface FederationBinding {
  id: string;
  platform_id: string;
  realm_id: string;
  issuer: string;
  audience: string;
  match_claims: Record<string, string>;
  mapped_role?: string;
  scope?: string[];
  status: string;
  /** Unix seconds; absent until first successful exchange. */
  last_used_at?: number;
  created_at?: number;
  [k: string]: unknown;
}

/**
 * Create payload. `issuer` must be an RI-known provider (v1: GCP
 * `accounts.google.com` or GitHub `token.actions.githubusercontent.com`);
 * `matchClaims` must constrain at least the provider's mandatory claim.
 * `audience` is forced to the global RI constant server-side.
 */
export interface FederationBindingCreate {
  issuer: string;
  matchClaims: Record<string, string>;
  /** Role stamped on the minted platform session (defaults to platform_api). */
  mappedRole?: string;
  scope?: string[];
}

export interface FederationBindingRevokeResult {
  status: string;
  id: string;
}

export class FederationBindingsClient {
  constructor(private readonly http: HttpClient, private readonly realmId: string) {}

  private base(): string {
    return `/platforms/${encodeURIComponent(this.realmId)}/federation-bindings`;
  }

  list(opts?: PageOpts): Paginated<FederationBinding> {
    return paginate<FederationBinding>(async (po) => {
      const raw = await this.http.request<unknown>({
        method: "GET",
        path: this.base(),
        query: { cursor: po.cursor, limit: po.limit ?? opts?.limit },
      });
      return readPage<FederationBinding>(raw);
    });
  }

  async create(body: FederationBindingCreate): Promise<FederationBinding> {
    return this.http.request<FederationBinding>({
      method: "POST",
      path: this.base(),
      body: {
        issuer: body.issuer,
        match_claims: body.matchClaims,
        mapped_role: body.mappedRole,
        scope: body.scope,
      },
    });
  }

  /** Revoke (soft-delete) a binding by id. A second call on a removed id 404s. */
  async revoke(bindingId: string): Promise<FederationBindingRevokeResult> {
    return this.http.request<FederationBindingRevokeResult>({
      method: "DELETE",
      path: `${this.base()}/${encodeURIComponent(bindingId)}`,
    });
  }
}
