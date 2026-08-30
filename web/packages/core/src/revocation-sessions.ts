/**
 * The pre-session revocation-token flow — the companion to the session-limit
 * `412` gate (BFF-SPEC item 6).
 *
 * When a login is refused with `session_limit_reached`, the envelope carries a
 * ONE-SHOT `revocation_token`. That token — not a session, which does not exist
 * yet — is the credential for the two calls below, so the user can see their
 * live sessions, drop one, and retry the login. Without them the gate is a dead
 * end that only waiting out an idle TTL can clear.
 *
 * Both calls are ANONYMOUS with an explicit bearer: the SDK must not attach a
 * session bearer it does not have, and must not try to refresh one.
 *
 * NOT the same surface as the authenticated session list (`/auth/sessions` on
 * the issuer, reached through `@realm-id/web-admin`'s `sessions` resource).
 * These are the BFF's own typed `/sessions` routes.
 */

import { bffCall, type RealmFetchLike } from "./bff-call.js";

/**
 * A session as the revocation-token list returns it. The canonical shape for
 * this row in the browser SDKs — `@realm-id/web-admin` re-exports it as
 * `ActiveSession` rather than declaring a second copy.
 */
export interface RevocableSession {
  id: string;
  origin?: string;
  /** Human-readable device label recorded at login (e.g. a CLI hostname),
   *  surfaced so a user can tell sessions apart for revocation (ADR-062). */
  device_name?: string;
  created_at: number;
  last_seen_at?: number;
}

export interface RevocationSessionsOptions {
  /** Absolute base URL of the BFF — `Realm` does not expose its own. */
  baseUrl: string;
}

export interface RevocationSessions {
  /** List the identity's live sessions using the one-shot token. */
  list(revocationToken: string): Promise<RevocableSession[]>;
  /** Revoke ONE session so the refused login has room to complete. */
  revoke(sessionId: string, revocationToken: string): Promise<void>;
}

/** Bind the pre-session revocation flow to a realm's fetch. */
export function createRevocationSessions(
  realm: RealmFetchLike,
  opts: RevocationSessionsOptions,
): RevocationSessions {
  return {
    async list(revocationToken) {
      const d = await bffCall<{ items?: RevocableSession[] }>(realm, opts.baseUrl, {
        method: "GET",
        path: "/sessions",
        bearer: revocationToken,
      });
      return d?.items ?? [];
    },
    async revoke(sessionId, revocationToken) {
      await bffCall<void>(realm, opts.baseUrl, {
        method: "DELETE",
        path: `/sessions/${encodeURIComponent(sessionId)}`,
        bearer: revocationToken,
      });
    },
  };
}
