import { sessionKeyOf } from "./session-store.js";

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

/** Pluggable SESSION denylist (a `jti` denylist through v0.62; keyed on the session key from v0.63, SPEC §6.7.6). Cheap reads matter — `isRevoked` is on the
 *  hot path of every authenticated request. */
export interface RevocationCache {
  /**
   * Mark `jti` as revoked. `expiresAt` is the JWT's `exp` (seconds since
   * epoch), used as the cache entry TTL — partners' implementations
   * should evict on expiry so the cache never grows unboundedly.
   */
  revoke(key: string, expiresAtMs: number): Promise<void>;
  /**
   * Returns true when `jti` has been revoked and the TTL has not elapsed.
   * Errors propagate to the verifier which fails closed (request
   * rejected). Partners running an unreliable cache should swallow
   * transient errors inside their implementation.
   */
  isRevoked(key: string): Promise<boolean>;
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

/** What an UNVERIFIED peek at an access token yields (SPEC §6.7.6 R1). */
export interface PeekedToken {
  /** `sid`, else `jti`, else "" (SPEC §6.7.1). */
  sessionKey: string;
  jti: string;
  sid: string;
  sub: string;
  /** `iat` in whole seconds; 0 when absent / not numeric. */
  iat: number;
  /** `exp` in ms; 0 when absent. */
  expMs: number;
}

/** Decode a JWT payload without signature verification. Used by the §6.7
 *  session cache, which only ever acts on a token the partner already holds;
 *  signature verification stays the verifier's job. Empty fields on malformed input. */
export function peekJwtRevokeFields(jwt: string): PeekedToken {
  const none: PeekedToken = { sessionKey: "", jti: "", sid: "", sub: "", iat: 0, expMs: 0 };
  const parts = jwt.split(".");
  if (parts.length !== 3) return none;
  const payload = parts[1];
  if (payload === undefined) return none;
  try {
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const c = JSON.parse(json) as Record<string, unknown>;
    const jti = typeof c["jti"] === "string" ? c["jti"] : "";
    const sid = typeof c["sid"] === "string" ? c["sid"] : "";
    const sub = typeof c["sub"] === "string" ? c["sub"] : "";
    const iat = typeof c["iat"] === "number" ? Math.floor(c["iat"]) : 0;
    const expMs = typeof c["exp"] === "number" ? c["exp"] * 1000 : 0;
    return { sessionKey: sessionKeyOf({ sid, jti }), jti, sid, sub, iat, expMs };
  } catch {
    return none;
  }
}
