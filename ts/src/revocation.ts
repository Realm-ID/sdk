/**
 * Shared revocation cache — ADR-041 follow-up.
 *
 * RealmID's refresh-token revocation is server-tracked and instant. But
 * access tokens are stateless RS256 JWTs — once minted, they verify on
 * signature + exp alone until they naturally expire (default 15 minutes).
 *
 * Partners that want stop-the-bleed semantics on stolen access tokens
 * between "user clicks logout" and "JWT naturally expires" can wire a
 * shared RevocationCache. The verifier checks it after signature verify;
 * cache hit on the JWT's jti → reject as revoked.
 *
 * Pluggable: in-process LRU is shipped as the default; partners running
 * multi-instance backends supply Redis/memcached/etc. by implementing the
 * interface directly. OPT-IN: nil by default; verify() and logout() behave
 * as before when no cache is configured.
 */

/** Pluggable JTI denylist. Cheap reads matter — `isRevoked` is on the
 *  hot path of every authenticated request. */
export interface RevocationCache {
  /**
   * Mark `jti` as revoked. `expiresAt` is the JWT's `exp` (seconds since
   * epoch), used as the cache entry TTL — partners' implementations
   * should evict on expiry so the cache never grows unboundedly.
   */
  revoke(jti: string, expiresAtMs: number): Promise<void>;
  /**
   * Returns true when `jti` has been revoked and the TTL has not elapsed.
   * Errors propagate to the verifier which fails closed (request
   * rejected). Partners running an unreliable cache should swallow
   * transient errors inside their implementation.
   */
  isRevoked(jti: string): Promise<boolean>;
}

/** Single-process implementation suitable for a single partner-API
 *  replica or for tests. Multi-replica deployments should wire a shared
 *  backend (Redis, etc.) by implementing the RevocationCache interface
 *  directly. Lazily evicts expired entries; partners with high revocation
 *  churn can wrap with a periodic sweep. */
export class MemRevocationCache implements RevocationCache {
  private readonly entries = new Map<string, number>();
  private readonly now: () => number;

  constructor(now?: () => number) {
    this.now = now ?? (() => Date.now());
  }

  async revoke(jti: string, expiresAtMs: number): Promise<void> {
    if (!jti) return;
    this.entries.set(jti, expiresAtMs);
  }

  async isRevoked(jti: string): Promise<boolean> {
    if (!jti) return false;
    const exp = this.entries.get(jti);
    if (exp === undefined) return false;
    if (exp > 0 && this.now() > exp) {
      this.entries.delete(jti);
      return false;
    }
    return true;
  }

  /** Current entry count. Useful for tests + instrumentation. */
  size(): number {
    return this.entries.size;
  }
}

/** Decode a JWT payload without signature verification and return its
 *  `jti` and `exp` claims. Returns nulls on malformed input. Used by
 *  `auth.logout` to push the access token's jti into the revocation
 *  cache; signature verification stays the verifier's job. */
export function peekJwtRevokeFields(jwt: string): { jti: string; expMs: number } {
  const parts = jwt.split(".");
  if (parts.length !== 3) return { jti: "", expMs: 0 };
  const payload = parts[1];
  if (payload === undefined) return { jti: "", expMs: 0 };
  try {
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const c = JSON.parse(json) as { jti?: unknown; exp?: unknown };
    const jti = typeof c.jti === "string" ? c.jti : "";
    const exp = typeof c.exp === "number" ? c.exp * 1000 : 0;
    return { jti, expMs: exp };
  } catch {
    return { jti: "", expMs: 0 };
  }
}
