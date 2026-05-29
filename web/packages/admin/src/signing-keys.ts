/**
 * Signing-key rotation + suspend/unsuspend — ops-only **issuer** routes
 * at `/admin/platforms/{id}/signing-keys/rotate`, `/suspend`,
 * `/unsuspend` (`issuer/internal/httpapi/routes.go:157-159`), reached via
 * the BFF `/api` passthrough (the BFF registers no typed `/admin/*`
 * route). Authz is the session user's base-realm-staff role, carried by
 * the passthrough's `X-On-Behalf-Of-User`.
 */

import type { HttpLike } from "./transport.js";
import type { RotateSigningKeyResponse, SuspendPlatformResponse } from "./types.js";

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
}
