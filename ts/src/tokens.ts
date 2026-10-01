/**
 * Session revocation cache — SPEC §6.7 (rewritten for v0.63.0).
 *
 * RealmID revokes refresh tokens server-side; a partner verifies access tokens
 * locally and learns of neither. This client holds partner-side state about
 * SESSIONS (keyed `sid`, falling back to `jti`) in the REQUIRED
 * {@link SessionStateStore}, and refuses an access token as
 *   - revoked    — this app logged the session out; or
 *   - superseded — the session refreshed at T and the token's `iat < T`.
 *
 * Every entry and mark lives `H = 24 h` from its latest write (the issuer's
 * access-TTL ceiling). A store READ error fails open (the token passes, one
 * warning); a WRITE error is logged and never changes the response.
 */

import { peekJwtRevokeFields } from "./revocation.js";
import { RealmError } from "./errors.js";
import type { LogoutRequest } from "./auth.js";
import type { Logger } from "./logger.js";
import { NOOP_LOGGER } from "./logger.js";
import type { OrgSessionMode } from "./org-session.js";
import {
  SESSION_STATE_H_MS,
  isMemorySessionStore,
  nbKey,
  nbMemberKey,
  revKey,
  type SessionStateStore,
} from "./session-store.js";

/** Thrown by `tokens.gateRequest` when the access token's session is revoked
 *  or superseded. RealmError subclass with code `unauthorized` + a
 *  `revoked: true` detail so callers can branch precisely. */
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

export interface TokensClientOptions {
  now?: () => number;
  logger?: Logger;
  /** Resolves the realm's org-session mode for a token's `iss` (SPEC §6.7.3). Default: concurrent. */
  orgMode?: (iss: string) => Promise<OrgSessionMode>;
}

export class TokensClient {
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly orgMode: (iss: string) => Promise<OrgSessionMode>;

  constructor(private readonly store: SessionStateStore, opts: TokensClientOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.orgMode = opts.orgMode ?? (async () => "concurrent");
  }

  /** Records the token's SESSION revoked until now + H. Peeks, never verifies. No-op without a session key. */
  async markRevoked(accessToken: string): Promise<void> {
    const { sessionKey } = peekJwtRevokeFields(accessToken);
    await this.revokeSession(sessionKey);
  }

  /** Records `sessionKey` revoked until now + H (logout's `sid`). No-op on an empty key. */
  async revokeSession(sessionKey: string): Promise<void> {
    if (!sessionKey) return;
    try {
      await this.store.revokeSession(revKey(sessionKey), this.now() + SESSION_STATE_H_MS);
    } catch (e) {
      this.logger.warn("realmid: session store write failed (revokeSession)", { message: (e as Error).message });
    }
  }

  /**
   * Raises the session mark AND the membership mark to the token's `iat`. Call
   * only for a refresh that ROTATED the refresh token (SPEC §10.1 step 4b).
   * No-op without a session key, `sub` or `iat`.
   */
  async recordRefresh(newAccessToken: string): Promise<void> {
    const { sessionKey, sub, iat } = peekJwtRevokeFields(newAccessToken);
    if (!sessionKey || !sub || !iat) return;
    const nb = iat * 1000;
    const until = this.now() + SESSION_STATE_H_MS;
    try {
      await this.store.raiseNotBefore(nbKey(sessionKey), nb, until);
      await this.store.raiseNotBefore(nbMemberKey(sessionKey, sub), nb, until);
    } catch (e) {
      this.logger.warn("realmid: session store write failed (recordRefresh)", { message: (e as Error).message });
    }
  }

  /** True iff the token's session is revoked, or the mode-selected live mark is above the token's `iat`. */
  async isRevoked(accessToken: string): Promise<boolean> {
    const peek = peekJwtRevokeFields(accessToken);
    if (!peek.sessionKey) return false;
    try {
      const [rev, session, member] = await this.store.sessionStates([
        revKey(peek.sessionKey),
        nbKey(peek.sessionKey),
        nbMemberKey(peek.sessionKey, peek.sub),
      ]);
      if (rev?.revoked) return true;
      if (!(session?.notBefore) && !(member?.notBefore)) return false;
      // Mode is fetched only when a mark is live (SPEC §6.7.3 trigger (a)).
      const iss = issOf(accessToken);
      const mode = await this.orgMode(iss);
      const mark = (mode === "exclusive" ? session : member)?.notBefore ?? 0;
      if (!mark) return false;
      return peek.iat === 0 || peek.iat * 1000 < mark;
    } catch (e) {
      this.logger.warn("realmid: session store read failed; failing open", { message: (e as Error).message });
      return false;
    }
  }

  /** Throws {@link TokenRevokedError} when {@link isRevoked}. */
  async gateRequest(accessToken: string): Promise<void> {
    if (await this.isRevoked(accessToken)) throw new TokenRevokedError();
  }

  /**
   * Wraps a `logout()` call: peeks BEFORE the network call, then marks the
   * session revoked on success or failure (fail closed).
   */
  revokeOnLogout<T>(
    logoutFn: (req?: LogoutRequest) => Promise<T>,
  ): (accessToken: string, req?: LogoutRequest) => Promise<T> {
    return async (accessToken, req) => {
      const { sessionKey } = peekJwtRevokeFields(accessToken);
      try {
        return await logoutFn(req);
      } finally {
        await this.revokeSession(sessionKey);
      }
    };
  }

  /**
   * Drops the session's revoked entry, session mark and EVERY membership mark.
   * An empty key clears everything on an in-memory store; on a shared store it
   * is a no-op with a warning (the SDK never issues a keyspace-wide delete).
   */
  async evict(sessionKey = ""): Promise<void> {
    try {
      if (!sessionKey) {
        if (isMemorySessionStore(this.store)) await this.store.evict("");
        else this.logger.warn("realmid: tokens.evict() with no key ignored on a shared session store");
        return;
      }
      await this.store.evict(revKey(sessionKey));
      await this.store.evict(nbKey(sessionKey));
    } catch (e) {
      this.logger.warn("realmid: session store evict failed", { message: (e as Error).message });
    }
  }
}

function issOf(jwt: string): string {
  try {
    const p = jwt.split(".")[1] ?? "";
    const padded = p.replace(/-/g, "+").replace(/_/g, "/");
    const c = JSON.parse(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))) as { iss?: unknown };
    return typeof c.iss === "string" ? c.iss : "";
  } catch {
    return "";
  }
}
