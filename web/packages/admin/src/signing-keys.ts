/**
 * Split-signing custody status + cancel-downgrade are OWNER routes under
 * `/platforms/{id}/signing-keys/split` (via the BFF `/api` passthrough). The rest of
 * this client is ops-only: signing-key rotation + suspend/unsuspend — **issuer** routes
 * at `/admin/platforms/{id}/signing-keys/rotate`, `/suspend`,
 * `/unsuspend` (`issuer/internal/httpapi/routes.go:157-159`), reached via
 * the BFF `/api` passthrough (the BFF registers no typed `/admin/*`
 * route). Authz is the session user's base-realm-staff role, carried by
 * the passthrough's `X-On-Behalf-Of-User`.
 */

import type { SplitKeyUpload } from "./split-dealer.js";
import type { HttpLike } from "./transport.js";
import type { RotateSigningKeyResponse, SplitSigningStatus, SuspendPlatformResponse } from "./types.js";

export class SigningKeysClient {
  constructor(private readonly http: HttpLike) {}

  async rotate(platformId: string): Promise<RotateSigningKeyResponse> {
    return this.http.request<RotateSigningKeyResponse>({
      method: "POST",
      path: `/admin/platforms/${encodeURIComponent(platformId)}/signing-keys/rotate`,
    });
  }

  async suspend(platformId: string, reason?: string): Promise<SuspendPlatformResponse> {
    return this.http.request<SuspendPlatformResponse>({
      method: "POST",
      path: `/admin/platforms/${encodeURIComponent(platformId)}/suspend`,
      body: reason ? { reason } : {},
    });
  }

  async unsuspend(platformId: string): Promise<SuspendPlatformResponse> {
    return this.http.request<SuspendPlatformResponse>({
      method: "POST",
      path: `/admin/platforms/${encodeURIComponent(platformId)}/unsuspend`,
      body: {},
    });
  }

  /**
   * GET /platforms/{id}/signing-keys/split (`signing_keys:read`). The body is un-enveloped
   * (`raw()`); `last_handshake` is an RFC 3339 string (or null), as swagger's nullable date-time says.
   * An unknown `state` passes through: the console treats it as an error.
   */
  async splitStatus(platformId: string): Promise<SplitSigningStatus> {
    return this.http.request<SplitSigningStatus>({
      method: "GET",
      path: `/platforms/${encodeURIComponent(platformId)}/signing-keys/split`,
    });
  }

  /**
   * POST /platforms/{id}/signing-keys/split — upload RealmID's half of a dealt key
   * (`dealSplitKey().upload`). Realm owner; the MFA step-up is the caller's `realm.fetch` wrapper's
   * job. Never retries and never re-deals: after a failure, upload the SAME dealt key again.
   * Refusals (`400 split_key_size_unsupported` | `split_key_invalid`, `409 split_kid_in_use`, ...) are
   * `RealmError` (server code in `.code` or `.details.server_code`).
   */
  async uploadSplitKey(
    platformId: string,
    body: SplitKeyUpload & { overlap_d?: string },
  ): Promise<{ status: "uploaded"; kid: string }> {
    return this.http.request<{ status: "uploaded"; kid: string }>({
      method: "POST",
      path: `/platforms/${encodeURIComponent(platformId)}/signing-keys/split`,
      body,
    });
  }

  /**
   * DELETE /platforms/{id}/signing-keys/split/downgrade — cancel a pending downgrade (human
   * realm owner only). 404 `no_pending_downgrade`, 403 `not_available_to_api_keys` |
   * `actor_required`, 501 `split_custody_unavailable`.
   */
  async cancelDowngrade(platformId: string): Promise<{ status: "cancelled" }> {
    return this.http.request<{ status: "cancelled" }>({
      method: "DELETE",
      path: `/platforms/${encodeURIComponent(platformId)}/signing-keys/split/downgrade`,
    });
  }
}
