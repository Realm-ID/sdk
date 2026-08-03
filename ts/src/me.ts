/**
 * Membership self-service — `realm.me.*` (ADR-092 D5). Settle the
 * single-tenant picker, decline an invitation, leave an org.
 *
 * Every route here is authorized by the END USER, never by the platform
 * credential alone: the subject is whoever the session says it is, so no path
 * parameter names someone else. Two auth modes, mirroring the rest of the SDK:
 *
 * - DIRECT — pass `userBearer` (the user's access JWT); it becomes the wire
 *   bearer.
 * - BFF — pass `userToken` (the user's *verified* access JWT); the realm's
 *   platform token stays the bearer and the user JWT rides as `X-User-Token`.
 *   A BARE user id is NOT an identity — the issuer removed that in v0.66.0 and
 *   answers `401 x_user_token_required` — which is why there is no userId mode.
 */

import type { HttpClient } from "./http.js";

/** The end-user credential every `realm.me.*` call needs. */
export interface MeAuth {
  /** The user's access JWT, used AS the bearer (direct mode). */
  userBearer?: string;
  /** The user's verified access JWT, forwarded as `X-User-Token` (BFF mode). */
  userToken?: string;
}

/** Settles the ADR-092 D5 picker. `tenantId` is the membership to KEEP. */
export interface TenantChoiceRequest extends MeAuth {
  tenantId: string;
}

export interface TenantChoiceResult {
  tenantId: string;
  /** Always `"chosen"`. */
  status: string;
  /**
   * How many memberships were given up. They are SUSPENDED, not deleted (a
   * login-time picker should not be the most destructive operation in the
   * product), so an admin can restore one and the user can still `leave()`
   * deliberately.
   */
  released: number;
}

/** Names one of the caller's own memberships by tenant id. */
export interface MembershipRequest extends MeAuth {
  tenantId: string;
}

/** Outcome of `acceptInvitation` (`"accepted"`), `rejectInvitation`
 * (`"rejected"`) or `leave` (`"left"`). */
export interface MembershipResult {
  tenantId: string;
  status: string;
}

interface RawMembershipResult {
  tenant_id?: string;
  status?: string;
  released?: number;
}

export class MeClient {
  constructor(private readonly http: HttpClient) {}

  /** Per-call bearer + headers for the two auth modes; see the module doc. */
  private authOf(a: MeAuth): { bearer?: string; headers?: Record<string, string> } {
    if (a.userBearer) return { bearer: a.userBearer };
    if (a.userToken) return { headers: { "X-User-Token": a.userToken } };
    return {};
  }

  /**
   * Answers the picker raised by `LoginResponse.tenantChoiceRequired` —
   * `POST /me/tenant-choice`. Keeps `tenantId`, gives up the caller's other
   * memberships in that realm.
   *
   * An OWNED organization cannot be given up: `tenants.owner_user_id` is NOT
   * NULL, so releasing the owner's membership would strand it. The server
   * refuses with `owner_cannot_be_revoked` (409) BEFORE mutating anything, so
   * a rejected choice never leaves the caller half-reconciled; ownership must
   * be transferred (ADR-076) first. `single_tenant_not_required` (409) means
   * the realm does not require single-tenant membership — nothing to settle.
   */
  async chooseTenant(req: TenantChoiceRequest): Promise<TenantChoiceResult> {
    const raw = await this.http.request<RawMembershipResult>({
      method: "POST",
      path: "/me/tenant-choice",
      body: { tenant_id: req.tenantId },
      ...this.authOf(req),
    });
    return {
      tenantId: raw?.tenant_id ?? req.tenantId,
      status: raw?.status ?? "",
      released: raw?.released ?? 0,
    };
  }

  /**
   * Accepts a PENDING invitation — `POST /me/invitations/{tenantId}/accept`.
   *
   * The mirror of `rejectInvitation`, and the reason both exist: a realm on
   * `invitation_acceptance: "explicit"` (ADR-095 D2) no longer activates an
   * invitation implicitly at login, so a decline path with no matching accept
   * path would leave an invitee able to say no and unable to say yes.
   *
   * On a realm using the default `"auto"` mode this still works — it settles a
   * row the invitee's next sign-in would have settled anyway. Only an offer can
   * be accepted: an already-active membership answers `not_invited` (409), and
   * an invitation already answered, revoked or expired answers `not_pending`.
   */
  async acceptInvitation(req: MembershipRequest): Promise<MembershipResult> {
    return this.membershipOp(req, `/me/invitations/${encodeURIComponent(req.tenantId)}/accept`);
  }

  /**
   * Declines a PENDING invitation — `POST /me/invitations/{tenantId}/reject`.
   *
   * Only an offer can be declined: an active member wanting out uses `leave()`
   * instead, and the server keeps the two apart with `not_invited` /
   * `not_pending` (409). The outcome is recorded rather than deleted, and the
   * live-invite unique index is partial, so the tenant MAY invite the same
   * person again later. A 404 deliberately does not distinguish "no such
   * tenant" from "not yours" — that difference would be an existence oracle
   * for tenant ids. `invitations_unavailable` (501) means the issuer runs
   * without an invitation-lifecycle store.
   */
  async rejectInvitation(req: MembershipRequest): Promise<MembershipResult> {
    return this.membershipOp(req, `/me/invitations/${encodeURIComponent(req.tenantId)}/reject`);
  }

  /**
   * Ends the caller's own membership of a tenant —
   * `POST /me/memberships/{tenantId}/leave`. This is the recovery path out of
   * a picker-induced suspension, which is why it is authorized by the caller's
   * realm session rather than a session in the tenant being left: requiring
   * the latter would demand the very access this recovers from.
   *
   * Sessions for that membership are revoked, so leaving is not cosmetic for a
   * token TTL. The tenant's OWNER is refused with `owner_cannot_leave` (409 —
   * transfer ownership first, ADR-076); an already-ended membership answers
   * `already_left` (409).
   */
  async leave(req: MembershipRequest): Promise<MembershipResult> {
    return this.membershipOp(req, `/me/memberships/${encodeURIComponent(req.tenantId)}/leave`);
  }

  /** The two no-body `{tenant_id, status}` routes. */
  private async membershipOp(req: MembershipRequest, path: string): Promise<MembershipResult> {
    const raw = await this.http.request<RawMembershipResult>({
      method: "POST",
      path,
      ...this.authOf(req),
    });
    return { tenantId: raw?.tenant_id ?? req.tenantId, status: raw?.status ?? "" };
  }
}
