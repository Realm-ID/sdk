/**
 * Subject-keyed authority cache — ADR-107.
 *
 * The ADR-041 `RevocationCache` is a jti DENYLIST, and that is the whole of
 * what it can express. It works for logout for exactly one reason: the user
 * presents their own token, so the SDK holds the jti at the moment it needs to
 * deny it.
 *
 * An admin demoting a colleague holds neither that colleague's access token nor
 * its jti, and there is no user → live-jti lookup anywhere in the SDK. Demotion
 * is therefore not "a missing feature of RevocationCache" — it is structurally
 * inexpressible there, whatever the interface is called (ADR-107 C2).
 *
 * `AuthorityCache` is the second cache D1 puts BESIDE it, never instead of it:
 * keyed by `sub`, storing a timestamp. `RevocationCache` is untouched and keeps
 * serving logout.
 */

/**
 * Records, per subject, the instant from which tokens are no longer trusted to
 * describe that subject's authority. A token is rejected iff its `iat` predates
 * the stored marker.
 *
 * The value is a TIMESTAMP and never a flag (D3). A boolean could not
 * self-heal: it would reject the REFRESHED token too, locking the user out for
 * the entry's whole TTL and turning a routine demotion into an outage.
 *
 * Reads sit on the hot path of every authenticated request, so keep
 * `staleSince` cheap. Rejections propagate to the verifier, which fails closed.
 */
export interface AuthorityCache {
  /**
   * Record that tokens for `sub` minted before `notBeforeMs` no longer describe
   * its authority. `expiresAtMs` is the entry's TTL — the maximum access-token
   * lifetime plus leeway, after which no token minted before the change can
   * still verify and the entry is dead weight (D6).
   */
  markStale(sub: string, notBeforeMs: number, expiresAtMs: number): Promise<void>;
  /**
   * The marker for `sub`, or `null` when the subject has no live entry.
   * `null` and `0` are NOT interchangeable: epoch 0 is a real instant, and a
   * cache that returned it for "no entry" would mark every subject stale
   * forever-ago, which reads as fine and silences the whole feature.
   */
  staleSince(sub: string): Promise<number | null>;
}

/**
 * Single-process default, lazily evicting on read exactly as
 * `MemRevocationCache` does.
 *
 * ⚠️ Correct for ONE replica and for tests, and silently wrong for more: a
 * marker written on replica A is invisible to replica B, so a demotion reaches
 * only whichever replica happens to serve the next request. A multi-replica
 * partner supplies Redis or equivalent — under D1 that is a DEPLOYMENT
 * REQUIREMENT, not a tuning choice.
 */
export class MemAuthorityCache implements AuthorityCache {
  private readonly entries = new Map<string, { notBeforeMs: number; expiresAtMs: number }>();
  private readonly now: () => number;

  constructor(now?: () => number) {
    this.now = now ?? (() => Date.now());
  }

  async markStale(sub: string, notBeforeMs: number, expiresAtMs: number): Promise<void> {
    if (!sub) return;
    // A later marker always wins; an EARLIER one is dropped rather than
    // stored, since moving the marker backwards would un-stale tokens a
    // previous change had already invalidated.
    const prev = this.entries.get(sub);
    const nb = prev && prev.notBeforeMs > notBeforeMs ? prev.notBeforeMs : notBeforeMs;
    this.entries.set(sub, { notBeforeMs: nb, expiresAtMs });
  }

  async staleSince(sub: string): Promise<number | null> {
    if (!sub) return null;
    const e = this.entries.get(sub);
    if (e === undefined) return null;
    if (e.expiresAtMs > 0 && this.now() > e.expiresAtMs) {
      this.entries.delete(sub);
      return null;
    }
    return e.notBeforeMs;
  }

  /** Current entry count. Useful for tests + instrumentation. */
  size(): number {
    return this.entries.size;
  }
}

/**
 * What the partner did. REQUIRED and validated rather than inferred (D11):
 * demotion does not evict the session, and a method that guessed would
 * eventually guess "log them out" on a routine role edit. Removing someone from
 * an org is a different intent with a different consequence — that one is
 * `sessions.revokeUser` (ADR-080).
 */
export type AuthorityChangeIntent = "demoted" | "promoted";

export interface AuthorityChange {
  /**
   * The `sub` claim of the affected principal — on this platform the
   * PER-MEMBERSHIP users-row id, not a person (D4). Demoting someone in org A
   * deliberately leaves their org B token untouched. A partner that passes an
   * identity id here silently propagates nothing.
   */
  subject: string;
  /** Required; see {@link AuthorityChangeIntent}. */
  intent: AuthorityChangeIntent;
  /**
   * Overrides the realm's access-token lifetime when sizing the cache entry
   * (D6). Omitted uses {@link DEFAULT_ACCESS_TTL_MS}. Set it when the realm's
   * `access_ttl_seconds` differs from the service default, or entries expire
   * while tokens minted before the change are still verifiable.
   */
  accessTokenTtlMs?: number;
}

/** The issuer's service-level access-token lifetime, which sizes the entry under D6. */
export const DEFAULT_ACCESS_TTL_MS = 15 * 60 * 1000;

/**
 * D8's allowance. The marker is stamped as `now − AUTHORITY_STALE_SKEW_MS`,
 * NEVER as bare `now`.
 *
 * The load-bearing constant of the whole design. Erring EARLY over-rejects a
 * handful of very recently minted tokens — one extra, harmless refresh each.
 * Erring LATE places the marker in the ISSUER's future, so a freshly-minted
 * token fails the very check that caused the refresh, and every replica
 * refreshes, fails and refreshes again against the mint endpoint. ADR-107 C5
 * calls that loop a worse outcome than the 900-second window it closes.
 */
export const AUTHORITY_STALE_SKEW_MS = 30 * 1000;
