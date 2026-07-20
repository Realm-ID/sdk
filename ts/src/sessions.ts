/**
 * Owner/admin session-revocation surface (ADR-080). Distinct from
 * `auth.revokeAllSessions`, which revokes the CURRENT user's own sessions.
 * Both operations require the `sessions:revoke` permission (owner implicit-all).
 */

import type { HttpClient } from "./http.js";

export interface SessionRevokeResult {
  status: string;
  revoked: number;
}

export class SessionsClient {
  constructor(private readonly http: HttpClient, private readonly realmId: string) {}

  /**
   * Force-log-out a specific user: every one of the target user's sessions in
   * the tenant's realm is revoked (`POST /tenants/{id}/users/{uid}/sessions/revoke`).
   * Distinct from the self-service `auth.revokeAllSessions`. Owner/admin only
   * (sessions:revoke). A user not in the tenant yields RealmError(not_found).
   */
  async revokeUser(tenantId: string, userId: string): Promise<SessionRevokeResult> {
    return this.http.request<SessionRevokeResult>({
      method: "POST",
      path: `/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/sessions/revoke`,
    });
  }

  /**
   * Realm-wide mass logout (`POST /platforms/{id}/sessions/revoke-all`) — every
   * session in the realm is revoked (e.g. breach response). The DB revocation
   * is authoritative; the Redis active-session sets are cleared realm-wide so
   * no user trips the session-limit counter on next login. Owner/admin only.
   */
  async revokeAll(): Promise<SessionRevokeResult> {
    return this.http.request<SessionRevokeResult>({
      method: "POST",
      path: `/platforms/${encodeURIComponent(this.realmId)}/sessions/revoke-all`,
    });
  }
}
