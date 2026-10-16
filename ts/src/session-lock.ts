/**
 * The per-session refresh lock and its outcome handoff — SPEC §10.1 steps
 * 4a/5/5a, §4.2, §4.3, §4.3a (go `0.63.0`-`0.64.2`).
 *
 * Refresh tokens are one-time-use and reuse revokes the session, so two requests
 * presenting ONE refresh token must not both reach the issuer. ONE lock
 * (`lockKey(refreshToken)` in the {@link SessionStateStore}) is taken by exactly:
 * the middleware's refresh route and its MFA-verify / recovery routes,
 * `auth.token` with a non-empty refresh token (and so the TokenManager), and a
 * direct `mfaVerify` / `mfaVerifyOtp` / `redeemRecoveryCode` given
 * `refreshToken`. It is NOT re-entrant: a caller that already holds it uses the
 * unlocked internals (`AuthClient.tokenUnlocked`).
 *
 * @internal Nothing here is partner API except what `index.ts` re-exports.
 */

import type { TokenRequest, TokenResponse } from "./auth.js";
import { RealmError, RefreshSupersededError } from "./errors.js";
import type { Logger } from "./logger.js";
import { scopeWireValue } from "./scope.js";
import { lockKey, outKey, type SessionStateStore } from "./session-store.js";

// Lock TTL = mint bound + 5 s: the bound starts after acquire and an outcome read,
// so a full-length mint must not outlive its lock (SPEC §10.1 step 4a).
export const LOCK_TTL_MS = 15_000;
export const OUTCOME_TTL_MS = 5_000;
export const MINT_BOUND_MS = 10_000;
export const POLL_MS = 50;
export const POLL_TRIES = 60;
/** The fingerprint an MFA verify / recovery redeem stores under the session key. */
export const MFA_VERIFY_FP = "mfa-verify";
/** How many times `auth.token` follows a rotated token handed over by a winner. */
const TOKEN_MAX_HOPS = 3;

/** The bound on every outcome load/store and lock release (go `storeOutcomeTimeout`). */
export const STORE_OUTCOME_TIMEOUT_MS = 2_000;

/**
 * Bounds a store call at {@link STORE_OUTCOME_TIMEOUT_MS}, INDEPENDENT of the request: a hung store
 * rejects at the bound instead of hanging the lock path (go `freshCtx`). Callers map the
 * rejection exactly as they map any store error.
 */
export function boundedStore<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`session store timed out after ${STORE_OUTCOME_TIMEOUT_MS} ms`)), STORE_OUTCOME_TIMEOUT_MS);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface LockDeps {
  store: SessionStateStore;
  logger: Logger;
}

/** What a winner stores for losers (SPEC §10.1 step 4a). Holds live credentials: 5 s TTL, secret. */
export interface RefreshOutcome {
  fp: string;
  ok: boolean;
  /** The refresh token the winner's response hands out. */
  refreshToken?: string;
  /** The candidate that actually minted (rotation is judged against it, §10.1 step 4b). */
  minter?: string;
  mint?: { accessToken: string; expiresIn: number; tenantId: string; role: string };
  /** `auth.token`'s own full result, for an identical-shape loser to adopt. */
  token?: TokenResponse;
  mode?: string;
  status?: number;
  body?: unknown;
}

export function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stableJson(o[k])).join(",") + "}";
}

/**
 * The status a BFF shows its SPA for an issuer refusal: the issuer's own, except
 * `escort_suspended` (403 upstream = the BFF's own escort account is disabled),
 * which becomes 503 so the SPA reads a service problem rather than its own user
 * being refused (ADR-104 R-d). Mirrors sdk/go `relayStatus`.
 */
export function relayStatus(e: RealmError, dflt = 500): number {
  if (e.code === "escort_suspended") return 503;
  return e.httpStatus ?? dflt;
}

/** The status a stored error outcome shows the SPA: the stored ISSUER status, remapped only here (go `toStoredErr` + relay). */
export function outcomeRelayStatus(o: RefreshOutcome): number {
  const code = ((o.body ?? {}) as { error?: { code?: string } }).error?.code;
  if (code === "escort_suspended") return 503;
  return o.status ?? 500;
}

export function errorOutcome(fp: string, e: unknown): RefreshOutcome {
  if (e instanceof RealmError) {
    // The ISSUER's status is stored; the relay remap (escort -> 503) happens on the wire only.
    return { fp, ok: false, status: e.httpStatus ?? 500, body: { ...(e.details ?? {}), error: { code: e.code, message: e.message } } };
  }
  return { fp, ok: false, status: 500, body: { error: { code: "server_error", message: (e as Error).message ?? "unknown" } } };
}

/** Rebuilds the RealmError a stored error outcome describes. */
function errorOfOutcome(o: RefreshOutcome): RealmError {
  const { error, ...details } = (o.body ?? {}) as { error?: { code?: string; message?: string } } & Record<string, unknown>;
  return new RealmError({
    code: (error?.code ?? "server_error") as RealmError["code"],
    message: error?.message ?? "refresh failed",
    httpStatus: o.status,
    details: Object.keys(details).length > 0 ? details : undefined,
  });
}

const unavailable = (cause?: unknown): RealmError =>
  new RealmError({ code: "server_error", message: "session store unavailable", httpStatus: 503, cause });
const inProgress = (): RealmError =>
  new RealmError({ code: "server_error", message: "refresh in progress", httpStatus: 503 });

/**
 * Reads the stored outcome for `key` (a refresh token). `undefined` is "none
 * stored"; a THROWN error is "could not find out" and MUST NOT be read as none:
 * a caller that mints on it re-presents a spent token (a reuse, which revokes
 * the session).
 */
export async function readOutcome(store: SessionStateStore, outcomeKey: string): Promise<RefreshOutcome | undefined> {
  const raw = await boundedStore(store.getRefreshResult(outcomeKey));
  return raw === undefined ? undefined : (JSON.parse(raw) as RefreshOutcome);
}

export async function storeOutcome(deps: LockDeps, refreshToken: string, o: RefreshOutcome): Promise<void> {
  try {
    await boundedStore(deps.store.putRefreshResult(await outKey(refreshToken), JSON.stringify(o), OUTCOME_TTL_MS));
  } catch (e) {
    deps.logger.warn("realmid: storing refresh outcome failed", { message: (e as Error).message });
  }
}

/**
 * Takes the per-session lock keyed on `refreshToken`, WAITING for it (50 ms x
 * 60) when held. The one wait-and-acquire loop shared by the middleware's MFA
 * routes and a direct call given `refreshToken`. Fails CLOSED: a store error is
 * a retryable 503 "session store unavailable"; the lock still held after the
 * waits is a retryable 503 "refresh in progress".
 */
export async function acquireSessionLock(deps: LockDeps, refreshToken: string): Promise<() => Promise<void>> {
  const lk = await lockKey(refreshToken);
  for (let i = 0; i < POLL_TRIES; i++) {
    let l;
    try {
      l = await deps.store.acquireRefreshLock(lk, LOCK_TTL_MS);
    } catch (e) {
      deps.logger.warn("realmid: refresh lock failed", { message: (e as Error).message });
      throw unavailable(e);
    }
    if (l.acquired) {
      return async () => {
        try { await boundedStore(l.release()); } catch (e) { deps.logger.warn("realmid: refresh lock release failed", { message: (e as Error).message }); }
      };
    }
    if (i + 1 < POLL_TRIES) await sleepMs(POLL_MS);
  }
  throw inProgress();
}

/**
 * Runs `run` (the issuer work under a lock) bounded at the 10 s mint bound,
 * INDEPENDENT of the request: on the bound the caller gets a 504 outcome, and a
 * run that settles late is handed to `onLate`, so a rotation the issuer
 * performed is never lost (SPEC §10.1 step 4a).
 */
export async function boundedOutcome(
  fp: string,
  run: () => Promise<RefreshOutcome>,
  onLate: (o: RefreshOutcome) => Promise<void>,
): Promise<RefreshOutcome> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = run().catch((e) => errorOutcome(fp, e));
  const bound = new Promise<RefreshOutcome>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(errorOutcome(fp, new RealmError({ code: "server_error", message: "refresh timed out", httpStatus: 504 })));
    }, MINT_BOUND_MS);
  });
  void settled.then((o) => (timedOut ? onLate(o).catch(() => undefined) : undefined));
  try {
    return await Promise.race([settled, bound]);
  } finally {
    clearTimeout(timer);
  }
}

/** The refresh token the issuer rotated to, if it did. A post-verify MINT failure (`LoginMintError`) still carries the session the issuer created, so its token counts. */
export function rotatedRefreshToken(out: { refreshToken?: string } | undefined, err?: unknown): string {
  if (err === undefined) return out?.refreshToken ?? "";
  const s = (err as { name?: string; session?: { refreshToken?: unknown } } | null);
  if (s?.name === "LoginMintError" && typeof s.session?.refreshToken === "string") return s.session.refreshToken;
  return "";
}

/**
 * Runs `fn` under the per-session lock when `refreshToken` is set (a direct
 * `mfaVerify` / `redeemRecoveryCode` call, SPEC §4.3, or the middleware MFA
 * routes). `fn` runs bounded at the mint timeout; the refresh token it rotated
 * to (also from a post-verify mint failure) is stored as the same `mfa-verify`
 * outcome BEFORE the lock is released, so a refresh waiting on the lock is
 * handed the rotated token. Empty `refreshToken` = no lock, `fn` runs bare.
 */
export async function withSessionLock<T extends { refreshToken?: string }>(
  deps: LockDeps,
  refreshToken: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!refreshToken) return fn();
  const release = await acquireSessionLock(deps, refreshToken);
  try {
    const remember = async (out: T | undefined, err?: unknown): Promise<void> => {
      const rotated = rotatedRefreshToken(out, err);
      if (rotated) await storeOutcome(deps, refreshToken, { fp: MFA_VERIFY_FP, ok: true, refreshToken: rotated });
    };
    const box: { value?: T; failure?: unknown; failed: boolean } = { failed: false };
    const o = await boundedOutcome(
      MFA_VERIFY_FP,
      async () => {
        try {
          box.value = await fn();
        } catch (e) {
          box.failed = true;
          box.failure = e;
        }
        await remember(box.value, box.failed ? box.failure : undefined); // also when the bound already fired
        return { fp: MFA_VERIFY_FP, ok: !box.failed };
      },
      async () => undefined,
    );
    if (box.failed) throw box.failure;
    // The bound fired first: the work is still running and stores its own rotation when it settles.
    if (!o.ok) throw errorOfOutcome(o);
    return box.value as T;
  } finally {
    await release();
  }
}

// ---- auth.token under the lock (SPEC §4.2, go 0.64.2) ----

/** Everything in the request that shapes the minted token. The "token\0" prefix is shared with no middleware outcome. */
function tokenFingerprint(req: TokenRequest): string {
  return "token\u0000" + stableJson({
    t: req.tenantId, c: req.customClaims ?? null, r: req.rolePermissions ?? null,
    p: req.productRoles ?? null, s: req.scope ?? null,
  });
}

/** A stored error about the refresh token ITSELF (dead, expired, revoked, spent): the same for every request shape. */
function tokenLevelErr(o: RefreshOutcome): boolean {
  const code = ((o.body ?? {}) as { error?: { code?: string } }).error?.code;
  return code === "refresh_invalid" || o.status === 401;
}

function tokenOutcomeUsable(o: RefreshOutcome, fp: string, key: string): boolean {
  if (!o.ok) return o.fp === fp || tokenLevelErr(o);
  if (o.fp === fp) return true;
  return !!o.refreshToken && o.refreshToken !== key;
}

/**
 * `auth.token` under the per-session lock. It follows the middleware refresh's
 * single-flight semantics: the winner of the lock looks for a stored outcome,
 * else mints and stores its own; a loser waits and adopts it. A concurrent
 * identical request adopts the winner's result; one whose request differs
 * retries on the winner's ROTATED token (never the spent one), up to three
 * hops, then fails with a {@link RefreshSupersededError} carrying the newest
 * token. An empty refresh token takes no lock.
 */
export async function tokenUnderLock(
  deps: LockDeps,
  req: TokenRequest,
  mint: (r: TokenRequest) => Promise<TokenResponse>,
): Promise<TokenResponse> {
  if (!req.refreshToken) return mint(req);
  // A bad request never spends (and so never rotates away) the token: refuse it before taking the lock.
  scopeWireValue(req.scope);
  let cur = req;
  for (let hop = 0; hop < TOKEN_MAX_HOPS; hop++) {
    const { res, next } = await tokenLockedOnce(deps, cur, mint);
    if (res || !next) return res as TokenResponse;
    cur = { ...cur, refreshToken: next };
  }
  throw new RefreshSupersededError(cur.refreshToken);
}

async function tokenLockedOnce(
  deps: LockDeps,
  req: TokenRequest,
  mint: (r: TokenRequest) => Promise<TokenResponse>,
): Promise<{ res?: TokenResponse; next?: string }> {
  const { store } = deps;
  const key = req.refreshToken;
  const fp = tokenFingerprint(req);
  const lk = await lockKey(key);
  const ok = await outKey(key);
  let lock;
  try {
    lock = await store.acquireRefreshLock(lk, LOCK_TTL_MS);
  } catch (e) {
    deps.logger.warn("realmid: refresh lock failed", { message: (e as Error).message });
    throw unavailable(e);
  }
  let oc: RefreshOutcome | undefined;
  let mintErr: unknown;
  if (lock.acquired) {
    try {
      try {
        oc = await readOutcome(store, ok);
      } catch (e) {
        // Could not find out whether a previous winner already rotated: minting could re-present a spent token. Fail closed.
        deps.logger.warn("realmid: reading refresh outcome failed", { message: (e as Error).message });
        throw unavailable(e);
      }
      // An outcome already stored (a repeat inside the window) answers the call, unless it was minted for another
      // request AND did not rotate the token: then there is no spent token to protect and this call mints.
      if (oc && !tokenOutcomeUsable(oc, fp, key)) oc = undefined;
      if (!oc) {
        const settle = (o: RefreshOutcome) => storeOutcome(deps, key, o);
        oc = await boundedOutcome(fp, async () => {
          try {
            const r = await mint(req);
            return { fp, ok: true, refreshToken: r.refreshToken, token: r };
          } catch (e) {
            mintErr = e; // the winner rethrows the ORIGINAL (cause intact); the stored copy is for losers
            throw e;
          }
        }, settle);
        await settle(oc); // errors too: a retry of a consumed token is a reuse
      }
    } finally {
      await boundedStore(lock.release()).catch((e) => deps.logger.warn("realmid: refresh lock release failed", { message: (e as Error).message }));
    }
  } else {
    for (let i = 0; i < POLL_TRIES && !oc; i++) {
      // A read error here keeps polling: a loser never mints, so waiting is safe.
      oc = await readOutcome(store, ok).catch(() => undefined);
      if (!oc) await sleepMs(POLL_MS);
    }
    if (!oc) throw inProgress();
  }
  if (!oc.ok) {
    if (mintErr instanceof RealmError && oc.fp === fp) throw mintErr;
    if (oc.fp === fp || tokenLevelErr(oc)) throw errorOfOutcome(oc);
    // Another request's shape-specific failure says nothing about this one. Every issuer 4xx on /auth/token is
    // returned before the rotation is written, so the token is still live: go round again on it.
    return { next: key };
  }
  if (oc.fp !== fp) {
    // Minted for a different request or by an MFA verify: hand over the rotated token; the caller retries on it.
    return { next: oc.refreshToken || key }; // a non-rotating class: nothing was spent
  }
  if (!oc.token) throw new RealmError({ code: "server_error", message: "refresh outcome unreadable", httpStatus: 503 });
  return { res: oc.token };
}
