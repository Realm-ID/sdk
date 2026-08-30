/**
 * `TenantsClient` with the ADR-080 identity-binding ops installed under its
 * `users` / `driftReviews` sub-clients, plus the ADR-087 email-recipient form
 * of `transferOwner`. Extends the bundled `@realm-id/sdk` `TenantsClient` so
 * every existing method (list/get/create/invitations/contactVerifications/…)
 * is inherited verbatim; only the two ADR-080-extended sub-clients are swapped
 * in and the one method below widened.
 *
 * The base declares `users`/`driftReviews` `readonly`, so the swap uses a
 * mutable cast in the constructor. `declare readonly` re-types the fields to
 * the extended classes for consumers without emitting a second field.
 */

import { TenantsClient } from "@realm-id/sdk/internal";
import type { Tenant } from "@realm-id/sdk/internal";
import { AdminUsersClient, AdminDriftReviewsClient } from "./user-binding.js";

type SdkHttp = ConstructorParameters<typeof TenantsClient>[0];

/**
 * Who is receiving the org.
 *
 * A plain string is the canonical resolved `owner_user_id`: the recipient must
 * already be an ACTIVE member of the tenant (issuer §4 lockout guard).
 *
 * `{ email }` is the **ADR-087 parent path**. A platform owner acting on one of
 * their realm's orgs clears `requireTenantMaintenance` WITHOUT being a member
 * of the target, and ADR-067 keeps roster reads own-tenant only — so that
 * caller cannot pick a recipient from a list and must name one by address. The
 * server resolves it, or PROVISIONS it inside the target org.
 * (`issuer/internal/httpapi/tenants.go:1148,1288`.)
 */
export type OwnerRecipient = string | { email: string };

/** What becomes of the OUTGOING owner. At most one disposition may be set. */
export interface AdminTransferOwnerOptions {
  /** Role the outgoing owner is demoted to (server default when omitted).
   *  Ignored when `leaveEntirely` or `suspendOutgoingOwner` is set. */
  outgoingOwnerRole?: string;
  /** Remove the outgoing owner from the tenant entirely instead of demoting. */
  leaveEntirely?: boolean;
  /**
   * Settle the outgoing owner as `suspended` instead (ADR-087 §4). Suspended —
   * not deactivated — because the row, its memberships and its history survive,
   * so a mistyped transfer is reversible in one hop rather than a permanent
   * loss of the org. Mutually exclusive with `leaveEntirely`.
   */
  suspendOutgoingOwner?: boolean;
}

export class AdminTenantsClient extends TenantsClient {
  declare readonly users: AdminUsersClient;
  declare readonly driftReviews: AdminDriftReviewsClient;

  constructor(http: SdkHttp, realmId: string) {
    super(http, realmId);
    const mut = this as unknown as {
      users: AdminUsersClient;
      driftReviews: AdminDriftReviewsClient;
    };
    mut.users = new AdminUsersClient(http);
    mut.driftReviews = new AdminDriftReviewsClient(http);
  }

  /**
   * Reassign tenant ownership — the ADR-076 §3 direct owner-pointer op
   * (`PUT /tenants/{id}/owner`).
   *
   * Widens the bundled SDK's signature, which only knows the resolved-user_id
   * form, to accept either {@link OwnerRecipient} shape and the third outgoing
   * disposition. Two things are refused HERE rather than spending a round trip
   * on a refusal the server has already documented:
   *
   *   - an empty recipient — posting `owner_user_id: ""` makes the server take
   *     a branch the caller did not mean;
   *   - `leaveEntirely` together with `suspendOutgoingOwner`, which the issuer
   *     rejects as `conflicting_outgoing_disposition`.
   *
   * Exactly ONE recipient key is ever sent, for the same reason.
   */
  async transferOwner(
    id: string,
    recipient: OwnerRecipient,
    opts?: AdminTransferOwnerOptions,
  ): Promise<Tenant> {
    if (opts?.leaveEntirely && opts?.suspendOutgoingOwner) {
      throw new Error(
        "transferOwner: leaveEntirely and suspendOutgoingOwner are mutually exclusive",
      );
    }

    const body: Record<string, unknown> = {};
    if (typeof recipient === "string") {
      const uid = recipient.trim();
      if (!uid) throw new Error("transferOwner: a recipient user id is required");
      body.owner_user_id = uid;
    } else {
      const email = (recipient?.email ?? "").trim();
      if (!email) throw new Error("transferOwner: a recipient email is required");
      body.new_owner_email = email;
    }

    if (opts?.outgoingOwnerRole !== undefined) body.outgoing_owner_role = opts.outgoingOwnerRole;
    if (opts?.leaveEntirely !== undefined) body.leave_entirely = opts.leaveEntirely;
    if (opts?.suspendOutgoingOwner !== undefined) {
      body.suspend_outgoing_owner = opts.suspendOutgoingOwner;
    }

    return (this as unknown as { http: { request<T>(o: unknown): Promise<T> } }).http.request<Tenant>({
      method: "PUT",
      path: `/tenants/${encodeURIComponent(id)}/owner`,
      body,
    });
  }
}
