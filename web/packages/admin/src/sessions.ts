/**
 * In-app sessions admin — post-login revocation surface. Bears the
 * current session token (auto-attached by `realm.fetch`) and routes via
 * the BFF `/api` passthrough to the **issuer**'s authed `/auth/sessions`
 * surface (`issuer/internal/httpapi/routes.go:55-57`); the passthrough
 * attaches the platform token + `X-On-Behalf-Of-User`. `/auth/sessions`
 * is NOT a BFF typed route (the BFF's typed `/sessions` is the separate
 * pre-login revocation-token flow), so it is intentionally absent from
 * `BFF_DIRECT_PREFIXES` and must transit `/api`.
 *
 * NOTE: this is distinct from the pre-login revocation_token flow that
 * lives in `ui/web/src/api.ts` (session-limit modal); that one bears a
 * one-shot bearer and stays in the UI layer.
 */

import type { HttpLike } from "./transport.js";
import type { ActiveSession, SessionRevokeResult } from "./types.js";

export class SessionsClient {
  constructor(private readonly http: HttpLike) {}

  async list(): Promise<ActiveSession[]> {
    const d = await this.http.request<{ items: ActiveSession[] }>({
      method: "GET",
      path: "/auth/sessions",
    });
    return d.items;
  }

  async revoke(id: string): Promise<void> {
    await this.http.request<void>({
      method: "DELETE",
      path: `/auth/sessions/${encodeURIComponent(id)}`,
    });
  }

  async revokeAll(): Promise<void> {
    await this.http.request<void>({
      method: "DELETE",
      path: "/auth/sessions",
    });
  }

  /**
   * POST /tenants/{id}/users/{uid}/sessions/revoke — force-log-out a specific
   * member: every one of the target user's sessions in the tenant's realm is
   * revoked (ADR-080). Distinct from the self-service `revokeAll()` above,
   * which only touches the caller's own sessions. Owner/admin only
   * (`sessions:revoke`). A user not in the tenant → RealmError(not_found).
   */
  async revokeUser(tenantId: string, userId: string): Promise<SessionRevokeResult> {
    return this.http.request<SessionRevokeResult>({
      method: "POST",
      path: `/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/sessions/revoke`,
    });
  }

  /**
   * POST /platforms/{realmId}/sessions/revoke-all — realm-wide mass logout
   * (breach response): every session in the realm is revoked and the Redis
   * active-session sets are cleared realm-wide. Owner/admin only
   * (`sessions:revoke` on the realm). `realmId` is the platform id.
   */
  async revokeRealmSessions(realmId: string): Promise<SessionRevokeResult> {
    return this.http.request<SessionRevokeResult>({
      method: "POST",
      path: `/platforms/${encodeURIComponent(realmId)}/sessions/revoke-all`,
    });
  }
}
