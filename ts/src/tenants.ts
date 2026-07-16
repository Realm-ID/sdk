/**
 * Tenants management — SPEC §6.1, §6.2, §6.3.
 * Includes nested `invitations` and `users` namespaces.
 */

import type { HttpClient } from "./http.js";
import { paginate, readPage, type Paginated, type PageOpts } from "./pagination.js";

export interface Tenant {
  id: string;
  display_name?: string;
  owner_user_id?: string;
  config?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  [k: string]: unknown;
}

/**
 * Per-tenant signup policy (SPEC §6.1, ADR-045).
 *
 * - `closed` (default): invitation-only; `allowedDomains` is ignored.
 * - `allowlist`: auto-provision users whose verified email domain is
 *   listed in `allowedDomains`. The list must be non-empty.
 * - `open`: auto-provision every authenticated user. Reserved for the
 *   base admin tenant — partner tenants cannot set this mode.
 */
export type SignupMode = "closed" | "allowlist" | "open";

export interface TenantCreate {
  displayName: string;
  allowedDomains?: string[];
  signupMode?: SignupMode;
  [k: string]: unknown;
}

export interface UpdateUserRoleResult {
  id: string;
  role: string;
  tenant_id: string;
  updated_at: number;
}

export interface TenantPatch {
  displayName?: string;
  [k: string]: unknown;
}

/** Optional knobs for {@link TenantsClient.transferOwner} (ADR-076). */
export interface TransferOwnerOptions {
  /** Role the outgoing owner is demoted to (defaults server-side to admin).
   *  Ignored when `leaveEntirely` is true. */
  outgoingOwnerRole?: string;
  /** Remove the outgoing owner from the tenant entirely instead of demoting. */
  leaveEntirely?: boolean;
}

/**
 * Per-tenant (org) config PATCH body (PATCH /tenants/{id}/config).
 * Governance keys an org owner controls over the realm-defined role
 * catalog (roles/signing-keys overhaul):
 *  - `role_overrides`: names of realm roles this org disables for itself
 *    (disable-only; an org cannot re-enable a realm-disabled role).
 *  - `default_invitation_role`: the role new invites default to, chosen
 *    from the roles still active for this org.
 * Also carries the existing per-org `mfa_policy` / `signup_mode` keys.
 * Open index signature: the endpoint allowlists keys server-side.
 */
export interface TenantConfigPatch {
  role_overrides?: string[];
  default_invitation_role?: string;
  mfa_policy?: string;
  signup_mode?: SignupMode;
  [k: string]: unknown;
}

export interface Invitation {
  id: string;
  identifier: string;
  role?: string;
  status?: string;
  expires_at?: number;
  [k: string]: unknown;
}

export interface InvitationCreate {
  identifier: string;
  role?: string;
  [k: string]: unknown;
}

export interface User {
  id: string;
  email?: string;
  phone?: string;
  display_name?: string;
  status?: string;
  mfa_enabled?: boolean;
  role?: string;
  [k: string]: unknown;
}

export type UserStatus = "active" | "suspended" | "deactivated";

/** Optional filters for {@link UsersClient.list} (SPEC §6.3, S-07). */
export interface UserListOpts {
  /** Exact match: owner|admin|member|viewer. */
  role?: string;
  /** Exact match: active|suspended|invited|deactivated. */
  status?: string;
  /** Case-insensitive substring match on email. */
  q?: string;
}

/** Optional filters for {@link InvitationsClient.list} (SPEC §6.2, S-07). */
export interface InvitationListOpts {
  /** Exact match: pending|accepted|revoked|expired. */
  status?: string;
}

export class InvitationsClient {
  constructor(private readonly http: HttpClient) {}

  /**
   * List invitations in a tenant (SPEC §6.2). `opts.status` filters by
   * invitation status (pending|accepted|revoked|expired) server-side.
   */
  list(tenantId: string, opts?: InvitationListOpts & PageOpts): Paginated<Invitation> {
    return paginate<Invitation>(async (po) => {
      const raw = await this.http.request<unknown>({
        method: "GET",
        path: `/tenants/${encodeURIComponent(tenantId)}/invitations`,
        query: { status: opts?.status, cursor: po.cursor, limit: po.limit ?? opts?.limit },
      });
      return readPage<Invitation>(raw);
    });
  }

  async create(tenantId: string, body: InvitationCreate): Promise<Invitation> {
    return this.http.request<Invitation>({
      method: "POST",
      path: `/tenants/${encodeURIComponent(tenantId)}/invitations`,
      body,
    });
  }

  async delete(tenantId: string, invitationId: string): Promise<void> {
    await this.http.request({
      method: "DELETE",
      path: `/tenants/${encodeURIComponent(tenantId)}/invitations/${encodeURIComponent(invitationId)}`,
    });
  }
}

/** One row for UsersClient.importUsers (ADR-073 Release B). >=1 of email/phone. */
export interface ImportUserRow {
  /** Optional UUID. Becomes users.id (bring-your-own); reconciles if it exists
   *  in THIS tenant, rejects the file if it exists in another. Absent → minted. */
  user_id?: string;
  email?: string;
  /** E.164 (leading '+'). */
  phone?: string;
  role: string;
  display_name?: string;
  /** With provider_uid, writes an exact first-SSO binding. */
  provider?: "google" | "microsoft" | "apple" | "facebook" | "firebase";
  provider_uid?: string;
}

export interface ImportUserRowResult {
  line: number;
  /** Bring-your-own or minted-and-returned users.id. */
  user_id?: string;
  identifier?: string;
  status: "created" | "updated" | "failed" | "ok";
  error?: string;
  error_hint?: string;
}

export interface ImportUsersResult {
  /** false → validation rejected the file; nothing was written. */
  committed: boolean;
  imported: number;
  updated: number;
  failed: number;
  rows: ImportUserRowResult[];
}

export class UsersClient {
  constructor(private readonly http: HttpClient) {}

  /**
   * List users in a tenant (SPEC §6.3). `opts` may carry `role`/`status`/`q`
   * filters (server-side exact match on role/status, case-insensitive email
   * substring for `q`) alongside pagination.
   */
  list(tenantId: string, opts?: UserListOpts & PageOpts): Paginated<User> {
    return paginate<User>(async (po) => {
      const raw = await this.http.request<unknown>({
        method: "GET",
        path: `/tenants/${encodeURIComponent(tenantId)}/users`,
        query: {
          role: opts?.role,
          status: opts?.status,
          q: opts?.q,
          cursor: po.cursor,
          limit: po.limit ?? opts?.limit,
        },
      });
      return readPage<User>(raw);
    });
  }

  async get(tenantId: string, userId: string): Promise<User> {
    return this.http.request<User>({
      method: "GET",
      path: `/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}`,
    });
  }

  async updateStatus(tenantId: string, userId: string, status: UserStatus): Promise<User> {
    return this.http.request<User>({
      method: "PATCH",
      path: `/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/status`,
      body: { status },
    });
  }

  async updateContact(tenantId: string, userId: string, body: { email?: string; phone?: string }): Promise<User> {
    return this.http.request<User>({
      method: "PATCH",
      path: `/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}`,
      body,
    });
  }

  async enrollMfa(tenantId: string, userId: string): Promise<{ secret?: string; otpauth_uri?: string; [k: string]: unknown }> {
    return this.http.request({
      method: "POST",
      path: `/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/mfa/enroll`,
    });
  }

  async confirmMfa(tenantId: string, userId: string, code: string): Promise<{ status: string; [k: string]: unknown }> {
    return this.http.request({
      method: "POST",
      path: `/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/mfa/confirm`,
      body: { code },
    });
  }

  async resetMfa(tenantId: string, userId: string): Promise<void> {
    await this.http.request({
      method: "DELETE",
      path: `/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/mfa`,
    });
  }

  /**
   * Bulk-import pre-provisioned ACTIVE users into a tenant (ADR-073 Release B).
   * Two-phase, whole-file-atomic: when `committed` is false NOTHING was written
   * and each failing row carries `error`+`error_hint`. A row may bring its own
   * `user_id` (becomes `users.id`); rows without one get a minted id returned.
   * Always resolves HTTP 200 — inspect `committed`, not the status code.
   */
  async importUsers(tenantId: string, rows: ImportUserRow[]): Promise<ImportUsersResult> {
    return this.http.request<ImportUsersResult>({
      method: "POST",
      path: `/tenants/${encodeURIComponent(tenantId)}/users/import`,
      body: { users: rows },
    });
  }
}

export interface DriftReview {
  id: string;
  contact_id: string;
  user_id: string;
  asserted_value: string;
  asserted_method: string;
  asserted_provider_uid: string;
  seen_count: number;
  first_seen_at: number;
  last_seen_at: number;
  status: string;
  [k: string]: unknown;
}

export interface DriftAcceptResult {
  id: string;
  status: string;
  accepted_value: string;
  new_contact_id: string;
}

export interface DriftRejectResult {
  id: string;
  status: string;
  new_user_id: string;
  original_value: string;
}

export class DriftReviewsClient {
  constructor(private readonly http: HttpClient) {}

  list(tenantId: string, opts?: { userId?: string } & PageOpts): Paginated<DriftReview> {
    return paginate<DriftReview>(async (po) => {
      const raw = await this.http.request<unknown>({
        method: "GET",
        path: `/tenants/${encodeURIComponent(tenantId)}/contact-drift-reviews`,
        query: { user_id: opts?.userId, cursor: po.cursor, limit: po.limit ?? opts?.limit },
      });
      return readPage<DriftReview>(raw);
    });
  }

  async accept(tenantId: string, reviewId: string): Promise<DriftAcceptResult> {
    return this.http.request<DriftAcceptResult>({
      method: "POST",
      path: `/tenants/${encodeURIComponent(tenantId)}/contact-drift-reviews/${encodeURIComponent(reviewId)}/accept`,
    });
  }

  async reject(tenantId: string, reviewId: string): Promise<DriftRejectResult> {
    return this.http.request<DriftRejectResult>({
      method: "POST",
      path: `/tenants/${encodeURIComponent(tenantId)}/contact-drift-reviews/${encodeURIComponent(reviewId)}/reject`,
    });
  }
}

export interface ContactVerification {
  id: string;
  contact_id: string;
  user_id: string;
  method: string;
  provider_uid: string;
  state: string;
  created_at: number;
  expires_at?: number;
  [k: string]: unknown;
}

export interface ContactVerificationResult {
  id: string;
  state: string;
}

export class ContactVerificationsClient {
  constructor(private readonly http: HttpClient) {}

  list(tenantId: string, opts?: { state?: string } & PageOpts): Paginated<ContactVerification> {
    return paginate<ContactVerification>(async (po) => {
      const raw = await this.http.request<unknown>({
        method: "GET",
        path: `/tenants/${encodeURIComponent(tenantId)}/contact-verifications`,
        query: { state: opts?.state, cursor: po.cursor, limit: po.limit ?? opts?.limit },
      });
      return readPage<ContactVerification>(raw);
    });
  }

  async approve(tenantId: string, verificationId: string): Promise<ContactVerificationResult> {
    return this.http.request<ContactVerificationResult>({
      method: "POST",
      path: `/tenants/${encodeURIComponent(tenantId)}/contact-verifications/${encodeURIComponent(verificationId)}/approve`,
    });
  }

  async reject(tenantId: string, verificationId: string): Promise<ContactVerificationResult> {
    return this.http.request<ContactVerificationResult>({
      method: "POST",
      path: `/tenants/${encodeURIComponent(tenantId)}/contact-verifications/${encodeURIComponent(verificationId)}/reject`,
    });
  }
}

export class TenantsClient {
  readonly invitations: InvitationsClient;
  readonly users: UsersClient;
  readonly driftReviews: DriftReviewsClient;
  readonly contactVerifications: ContactVerificationsClient;

  constructor(private readonly http: HttpClient, private readonly realmId: string) {
    this.invitations = new InvitationsClient(http);
    this.users = new UsersClient(http);
    this.driftReviews = new DriftReviewsClient(http);
    this.contactVerifications = new ContactVerificationsClient(http);
  }

  list(opts?: PageOpts): Paginated<Tenant> {
    return paginate<Tenant>(async (po) => {
      const raw = await this.http.request<unknown>({
        method: "GET",
        path: "/tenants",
        query: { cursor: po.cursor, limit: po.limit ?? opts?.limit },
      });
      return readPage<Tenant>(raw);
    });
  }

  async get(id: string): Promise<Tenant> {
    return this.http.request<Tenant>({
      method: "GET",
      path: `/tenants/${encodeURIComponent(id)}`,
    });
  }

  async create(body: TenantCreate): Promise<Tenant> {
    // SPEC §6.1: realm is implicit (the API key's realm). Routes to
    // POST /platforms/{realmId}/tenants — the platform-token caller is
    // accepted via the service-JWT branch of requireTenantMaintenance.
    return this.http.request<Tenant>({
      method: "POST",
      path: `/platforms/${encodeURIComponent(this.realmId)}/tenants`,
      body: {
        display_name: body.displayName,
        allowed_domains: body.allowedDomains,
        signup_mode: body.signupMode,
        ...rest(body, ["displayName", "allowedDomains", "signupMode"]),
      },
    });
  }

  async update(id: string, patch: TenantPatch): Promise<Tenant> {
    return this.http.request<Tenant>({
      method: "PATCH",
      path: `/tenants/${encodeURIComponent(id)}`,
      body: {
        display_name: patch.displayName,
        ...rest(patch, ["displayName"]),
      },
    });
  }

  async updateConfig(id: string, patch: TenantConfigPatch): Promise<Tenant> {
    return this.http.request<Tenant>({
      method: "PATCH",
      path: `/tenants/${encodeURIComponent(id)}/config`,
      body: patch,
    });
  }

  async delete(id: string): Promise<void> {
    await this.http.request({
      method: "DELETE",
      path: `/tenants/${encodeURIComponent(id)}`,
    });
  }

  /**
   * Reassign tenant ownership to `newOwnerUserId` — the ADR-076 direct
   * owner-pointer op (PUT /tenants/{id}/owner). The recipient must be an
   * active member of the tenant. `opts` is optional: omit for a plain
   * hand-over (outgoing owner demoted to the server default), or set
   * `outgoingOwnerRole` / `leaveEntirely` to control the outgoing owner's fate.
   */
  async transferOwner(id: string, newOwnerUserId: string, opts?: TransferOwnerOptions): Promise<Tenant> {
    const body: Record<string, unknown> = { owner_user_id: newOwnerUserId };
    if (opts?.outgoingOwnerRole !== undefined) body.outgoing_owner_role = opts.outgoingOwnerRole;
    if (opts?.leaveEntirely !== undefined) body.leave_entirely = opts.leaveEntirely;
    return this.http.request<Tenant>({
      method: "PUT",
      path: `/tenants/${encodeURIComponent(id)}/owner`,
      body,
    });
  }

  /**
   * Set a user's role within a tenant. Role name must exist in the
   * realm's role catalog (see RolesClient.create). Setting role=owner
   * is rejected — use transferOwner for the explicit handover.
   * Demoting the last owner returns RealmError(last_owner).
   *
   * Wraps PATCH /tenants/{id}/users/{uid}/role.
   */
  async updateUserRole(tenantId: string, userId: string, role: string): Promise<UpdateUserRoleResult> {
    return this.http.request<UpdateUserRoleResult>({
      method: "PATCH",
      path: `/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/role`,
      body: { role },
    });
  }
}

function rest<T extends Record<string, unknown>>(obj: T, omit: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!omit.includes(k) && v !== undefined) out[k] = v;
  }
  return out;
}
