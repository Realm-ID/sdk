/**
 * Access-token revocation cache — SPEC §6.7.
 *
 * Server-side, RealmID revokes refresh tokens via `POST /auth/logout`.
 * Access tokens are stateless RS256 JWTs, so once minted they verify on
 * signature + exp alone until they naturally expire. This client adds
 * partner-side defense-in-depth: on logout, the access token's `jti`
 * is parked in an in-memory cache with TTL = `exp - now()`. Subsequent
 * requests presenting that JTI are rejected without a server round trip.
 *
 * Multi-pod caveat: this cache is **per-process**. A logout served by
 * pod A does not propagate to pod B; a stolen access token can still
 * be replayed against pod B for up to its remaining TTL. v1.1 ships a
 * Redis-backed cache for cross-pod coherence; for v1, accept the
 * staleness window or run a single replica behind your edge.
 *
 * Surface (all four wired onto `realm.tokens`):
 *   - markRevoked(accessToken)        — extract jti+exp, cache the jti.
 *   - isRevoked(accessToken)          — true iff cached and not expired.
 *   - revokeOnLogout(logoutFn)        — middleware wrapping `auth.logout`;
 *                                       fail-closed (caches even on
 *                                       network failure).
 *   - gateRequest(accessToken)        — throws TokenRevokedError on hit.
 */

import { peekJwtRevokeFields } from "./revocation.js";
import { RealmError } from "./errors.js";
import type { LogoutRequest } from "./auth.js";

/** Thrown by `tokens.gateRequest` when the access token's jti is in the
 *  per-process revoked cache. RealmError subclass with code `unauthorized`
 *  + a `revoked: true` detail so callers can branch precisely without
 *  growing the global ErrorCode taxonomy. */
export class TokenRevokedError extends RealmError {
  constructor(message = "access token revoked") {
    super({
      code: "unauthorized",
      message,
      details: { revoked: true },
    });
    this.name = "TokenRevokedError";
  }
}

/** Internal cache entry: epoch-ms expiry. */
interface Entry {
  expiresAt: number;
}

/** Per-process revoked-JTI cache. Concurrency: JS is single-threaded, no
 *  lock needed. */
export class TokensClient {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(now?: () => number) {
    this.now = now ?? (() => Date.now());
  }

  /**
   * Extract `jti` and `exp` from `accessToken` and cache the jti with
   * TTL = `exp - now()`. No-op when the token is malformed, missing
   * jti/exp, or already past expiry.
   */
  markRevoked(accessToken: string): void {
    const { jti, expMs } = peekJwtRevokeFields(accessToken);
    if (!jti || !expMs) return;
    if (expMs <= this.now()) return;
    this.entries.set(jti, { expiresAt: expMs });
  }

  /**
   * True iff `accessToken`'s jti is in the cache and the entry has not
   * expired. Lazy GC: stale entries are evicted on read. Returns false
   * for malformed input.
   */
  isRevoked(accessToken: string): boolean {
    const { jti } = peekJwtRevokeFields(accessToken);
    if (!jti) return false;
    const e = this.entries.get(jti);
    if (!e) return false;
    if (e.expiresAt <= this.now()) {
      this.entries.delete(jti);
      return false;
    }
    return true;
  }

  /**
   * Per-request gate. Partners' inbound middleware should call this
   * before forwarding to RealmID. Throws `TokenRevokedError` when the
   * jti is cached.
   */
  gateRequest(accessToken: string): void {
    if (this.isRevoked(accessToken)) {
      throw new TokenRevokedError();
    }
  }

  /**
   * Wraps a `logout()` call. Behavior: extract jti+exp BEFORE the
   * network call (so a network failure doesn't lose the data), run the
   * supplied logout, then mark the jti revoked locally regardless of
   * network outcome. Rationale: partner backend should fail closed —
   * if RI is unreachable, the access token still gets blackholed
   * locally so the user is logged out from the partner's perspective.
   */
  revokeOnLogout<T>(
    logoutFn: (req?: LogoutRequest) => Promise<T>,
  ): (accessToken: string, req?: LogoutRequest) => Promise<T> {
    return async (accessToken, req) => {
      const fields = peekJwtRevokeFields(accessToken);
      try {
        return await logoutFn(req);
      } finally {
        if (fields.jti && fields.expMs && fields.expMs > this.now()) {
          this.entries.set(fields.jti, { expiresAt: fields.expMs });
        }
      }
    };
  }

  /** Drop a single jti, or all entries when omitted. */
  evict(jti?: string): void {
    if (jti) this.entries.delete(jti);
    else this.entries.clear();
  }

  /** Current entry count. Useful for tests + instrumentation. */
  size(): number {
    return this.entries.size;
  }
}
