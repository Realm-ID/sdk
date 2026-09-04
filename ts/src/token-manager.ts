/**
 * Token manager for long-lived, single-identity clients — SPEC §4.2.1.
 *
 * A convenience wrapper over `auth.token()` (§4.2) for desktop apps, sync
 * agents, and daemons that hold one refresh token and need a
 * continuously-valid access token without hand-rolling the refresh loop.
 * It is NOT for browser/BFF flows (use the middleware, §10) nor for the
 * SDK's internal platform session (§4.0).
 *
 * Rotation safety: user refresh tokens are one-time-use and rotate on
 * every /auth/token (ADR-031). The manager therefore:
 *   (a) single-flights concurrent acquisitions so two callers never present
 *       the same refresh token in parallel (which would trip
 *       reuse-detection and kill the session), and
 *   (b) persists the rotated token through the `refreshSink` *before*
 *       returning the new access token, so a crash can never strand the
 *       client on a consumed token.
 *
 * Construct via `realm.auth.newTokenManager(refreshToken, opts)`.
 */

import type { AuthClient } from "./auth.js";
import { RealmError } from "./errors.js";

/**
 * Durably persists a rotated refresh token. The manager calls it after each
 * successful /auth/token and AWAITS it: only if it resolves does the manager
 * cache and hand back the new access token. A sink that rejects fails the
 * acquisition (the caller's durable store still holds the previous token).
 * Best-effort / fire-and-forget sinks do NOT satisfy the crash-safety
 * contract (SPEC §4.2.1).
 */
export type RefreshSink = (newRefreshToken: string) => Promise<void> | void;

export interface TokenManagerOptions {
  /**
   * Tenant id sent on each /auth/token (required for multi-tenant user
   * refresh tokens; ignored otherwise).
   */
  tenantId?: string;
  /** Durable sink for rotated refresh tokens. See {@link RefreshSink}. */
  refreshSink?: RefreshSink;
  /** Clock override (tests only). Returns epoch milliseconds. */
  clock?: () => number;
}

/**
 * How far ahead of expiry the manager proactively refreshes, so callers
 * under steady load never observe an expired access token.
 */
const REFRESH_LEAD_MS = 60 * 1000;

/** Default access-token lifetime when the server omits expires_in (SPEC §4.0). */
const DEFAULT_ACCESS_TTL_MS = 5 * 60 * 1000;

interface InFlight {
  promise: Promise<string>;
}

export class TokenManager {
  private readonly auth: AuthClient;
  private readonly tenantId: string;
  private readonly sink?: RefreshSink;
  private readonly now: () => number;

  private refreshTokenValue: string;
  private cachedAccessToken = "";
  private accessExpiresAtMs = 0;
  private inflight: InFlight | null = null;
  /**
   * The access token the LAST forced refresh produced. The whole of D13's
   * bookkeeping: a `token_stale` on this exact token means the refresh already
   * happened and did not help, so refreshing again would be the loop. One
   * string, not a set — the cap is per token, and the only token that can be
   * "already refreshed for" is the one we just minted.
   */
  private forcedToken = "";

  constructor(auth: AuthClient, refreshToken: string, opts: TokenManagerOptions = {}) {
    this.auth = auth;
    this.refreshTokenValue = refreshToken;
    this.tenantId = opts.tenantId ?? "";
    this.sink = opts.refreshSink;
    this.now = opts.clock ?? (() => Date.now());
  }

  /**
   * Returns a valid access token, refreshing on demand. Returns the cached
   * token while it has at least 60s of life; otherwise performs (or joins)
   * a single refresh. A `refresh_invalid` error (SPEC §3.1) is terminal —
   * the caller should discard its stored refresh token and re-run its
   * login/enrollment flow.
   */
  async accessToken(): Promise<string> {
    if (this.cachedAccessToken !== "" && this.accessExpiresAtMs - this.now() >= REFRESH_LEAD_MS) {
      return this.cachedAccessToken;
    }
    // Join an in-flight acquisition rather than starting a second one — two
    // parallel /auth/token calls on the same one-time-use refresh token
    // would trip reuse-detection.
    if (this.inflight) {
      return this.inflight.promise;
    }
    const refresh = this.refreshTokenValue;
    const promise = this.fetch(refresh).finally(() => {
      this.inflight = null;
    });
    this.inflight = { promise };
    return promise;
  }

  /**
   * Answers an ADR-107 `token_stale` 401 by forcing ONE refresh and returning
   * the token to replay the original request with.
   *
   * D13, the loop-breaker. D8 makes the C5 loop very unlikely by stamping the
   * marker early; this makes it impossible, and it lives in the client SDK
   * because that is where the retry decision is actually made. A second
   * `token_stale` on a token this method already produced is a HARD failure —
   * rejected as `token_stale` so the caller can surface it, never retried.
   *
   * `staleToken` is the token the failing request carried. Passing one that is
   * no longer current is not an error: another caller already refreshed, and
   * you simply get the newer token to replay with, costing the issuer nothing.
   *
   * ```ts
   * let tok = await tm.accessToken();
   * try {
   *   return await call(tok);
   * } catch (e) {
   *   if (!isTokenStale(e)) throw e;
   *   tok = await tm.handleStale(tok);   // hard-rejects on the second try
   *   return await call(tok);            // surface a rejection; do NOT loop
   * }
   * ```
   */
  async handleStale(staleToken: string): Promise<string> {
    if (staleToken !== "" && staleToken === this.forcedToken) {
      throw new RealmError({
        code: "token_stale",
        httpStatus: 401,
        message:
          "realmid: token_stale on a token minted by the previous forced refresh — " +
          "refusing to refresh again (ADR-107 D13). The authority marker is ahead of " +
          "the issuer's clock, or the subject is being re-marked faster than a token " +
          "can be used.",
      });
    }
    // Someone else already refreshed past the failing token — replay with what
    // we hold rather than spending a mint.
    if (staleToken !== "" && this.cachedAccessToken !== "" && staleToken !== this.cachedAccessToken) {
      return this.cachedAccessToken;
    }
    // Drop the cached token so accessToken() cannot hand back the stale one.
    this.cachedAccessToken = "";
    this.accessExpiresAtMs = 0;
    const tok = await this.accessToken();
    this.forcedToken = tok;
    return tok;
  }

  /**
   * The manager's current refresh token (the latest rotated value). Useful
   * for a final persist on graceful shutdown.
   */
  refreshToken(): string {
    return this.refreshTokenValue;
  }

  /**
   * Performs one /auth/token acquisition. Only ever called by the
   * single-flight leader in {@link accessToken}.
   */
  private async fetch(refresh: string): Promise<string> {
    // refresh_invalid (and any other error) bubbles up unchanged: a
    // long-lived user client has no API key to fall back on, so a dead
    // refresh is terminal — re-authentication is required.
    const res = await this.auth.token({ refreshToken: refresh, tenantId: this.tenantId });

    if (!res.accessToken) {
      throw new RealmError({
        code: "server_error",
        message: "/auth/token returned empty access token",
      });
    }

    // User refresh always rotates; guard anyway so a non-rotating realm
    // config (service/platform) doesn't blank the stored token.
    const rotated = res.refreshToken || refresh;

    // Commit the rotated token to memory BEFORE persisting, so if the sink
    // fails and the caller retries, the retry presents the live (just
    // issued, unconsumed) token rather than the consumed one.
    this.refreshTokenValue = rotated;

    // Persist-before-return: the sink must durably store the rotated token
    // before we hand the caller an access token to use (SPEC §4.2.1). If it
    // rejects, fail the acquisition — do not cache the access token.
    if (this.sink) {
      try {
        await this.sink(rotated);
      } catch (e) {
        throw new RealmError({
          code: "server_error",
          message: "realmid token manager: persist rotated refresh token failed",
          cause: e,
        });
      }
    }

    const ttlMs = res.expiresIn > 0 ? res.expiresIn * 1000 : DEFAULT_ACCESS_TTL_MS;
    this.cachedAccessToken = res.accessToken;
    this.accessExpiresAtMs = this.now() + ttlMs;
    return res.accessToken;
  }
}
