/**
 * ADR-080 Phase B identity-binding admin ops layered onto the bundled
 * `@realm-id/sdk` `UsersClient` / `DriftReviewsClient`.
 *
 * The bundled `@realm-id/sdk` doesn't ship the ADR-080 methods (its vendored
 * build predates them), so we extend `UsersClient` / `DriftReviewsClient` here
 * — adding only the new methods, using result types defined locally in
 * `./types.js` so the shapes are correct regardless of the vendored SDK's
 * build state. `createAdmin` swaps these extended variants in under
 * `admin.tenants.users` / `admin.tenants.driftReviews`, so the placement
 * matches the Go SDK (delink/hand-back on Users, hard-reject on DriftReviews)
 * and existing call sites keep working.
 *
 * All three ops are owner/admin gated (`users:manage`) and route via the BFF
 * `/api` passthrough to the issuer's `/tenants/{id}/...` surface.
 */

import { UsersClient, DriftReviewsClient } from "@realm-id/sdk/internal";
import type { TenantsClient } from "@realm-id/sdk/internal";
import type {
  DelinkContactResult,
  HandBackResult,
  DriftRejectResult,
} from "./types.js";

/** The nominal `HttpClient` type the bundled resource classes are built on. */
type SdkHttp = ConstructorParameters<typeof TenantsClient>[0];

const enc = encodeURIComponent;

/**
 * `UsersClient` + the ADR-080 Part 2/3 owner recovery ops. Keeps its own
 * `_http` reference because the base class's `http` is `private` (not visible
 * to subclasses).
 */
export class AdminUsersClient extends UsersClient {
  constructor(private readonly _http: SdkHttp) {
    super(_http);
  }

  /**
   * POST /tenants/{id}/users/{uid}/contacts/{contactId}/delink — sever a
   * contact's provider binding (ADR-080 Part 2). Every active
   * `contact_verifications` row bound to the contact is revoked, leaving the
   * `user_contacts` row ACTIVE but unmapped so a new provider identity can
   * bind on the next verified login. The explicit owner action that unblocks a
   * `contact_admin_required` login. Owner/admin only. Idempotent.
   */
  async delinkContact(
    tenantId: string,
    userId: string,
    contactId: string,
  ): Promise<DelinkContactResult> {
    return this._http.request<DelinkContactResult>({
      method: "POST",
      path: `/tenants/${enc(tenantId)}/users/${enc(userId)}/contacts/${enc(contactId)}/delink`,
    });
  }

  /**
   * POST /tenants/{id}/users/{uid}/hand-back — hand an account back (ADR-080
   * Part 3). The target account (`userId`, currently deactivated/parked) is
   * reactivated and the mistakenly-created account's (`fromUserId`) current
   * email identity is moved onto it, then the source account is disabled. The
   * audited recovery for a drift/rebind that spawned a separate account.
   * Owner/admin only. A missing/same `from_user_id` or a source with no email
   * → RealmError(bad_request); a non-deactivated target → RealmError(conflict).
   */
  async handBack(
    tenantId: string,
    userId: string,
    fromUserId: string,
  ): Promise<HandBackResult> {
    return this._http.request<HandBackResult>({
      method: "POST",
      path: `/tenants/${enc(tenantId)}/users/${enc(userId)}/hand-back`,
      body: { from_user_id: fromUserId },
    });
  }
}

/**
 * `DriftReviewsClient` + the ADR-080 Part 3 hard-reject escalation. `reject()`
 * (soft, non-destructive) is inherited unchanged; its result type already
 * carries the new `mode`/`parked`/`revoked_bindings` shape.
 */
export class AdminDriftReviewsClient extends DriftReviewsClient {
  constructor(private readonly _http: SdkHttp) {
    super(_http);
  }

  /**
   * POST /tenants/{id}/contact-drift-reviews/{reviewId}/reject with
   * `{hard:true}` — park the account (ADR-080 Part 3): the provider binding is
   * severed, leaving the account unmapped (NOT silently re-invited). Recovery
   * is the explicit hand-back flow. A deliberate, audited "this looks like a
   * takeover" action. Response carries `mode:"hard"`, `parked`, and
   * `revoked_bindings`.
   */
  async rejectHard(
    tenantId: string,
    reviewId: string,
  ): Promise<DriftRejectResult> {
    return this._http.request<DriftRejectResult>({
      method: "POST",
      path: `/tenants/${enc(tenantId)}/contact-drift-reviews/${enc(reviewId)}/reject`,
      body: { hard: true },
    });
  }
}
