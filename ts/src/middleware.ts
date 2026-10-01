/**
 * Connect-style middleware — SPEC §10.
 *
 * One handler that routes the four auth ingress paths
 * (login/logout/refresh/mfa-verify) to the SDK and falls through to bearer
 * verification for everything else. Designed to mount on Express, Polka, or
 * raw http with no extra dependencies.
 *
 * Two SPEC §10 features wire here:
 *  - `tokenDelivery: "cookie" | "body"` controls how the refresh token
 *    flows back to the client. `body` mode is for native / mobile apps
 *    that can't use cookies; the refresh token appears in the JSON body
 *    instead, and logout/refresh read it from `req.body.refresh_token`.
 *  - `mfaProtectedPaths` is a glob list. On a verified-but-no-MFA token
 *    hitting one of those paths, the middleware responds 412 with a
 *    challenge-token envelope so the client can prompt and re-mint.
 */

import type { Realm } from "./realm.js";
import { RealmError } from "./errors.js";
import type { Claims } from "./claims.js";
import type { LoginRequest } from "./auth.js";
import type { Logger } from "./logger.js";
import { NOOP_LOGGER } from "./logger.js";
import { lockKey, outKey } from "./session-store.js";

/**
 * One entry in {@link MiddlewareConfig.mfaProtectedPaths}.
 *
 * Per-route MFA freshness policy (SPEC §10.4):
 *  - `maxAgeSeconds` — accept any token whose `mfa_at` claim is at most
 *    that old. Omit to inherit the realm-default (`mfaDefaultMaxAgeSeconds`).
 *    `0` is equivalent to `requireFresh: true` (no stale proof allowed).
 *  - `requireFresh` — require `mfa_at` within ~30 s. Use for irreversible /
 *    high-risk operations.
 */
export interface MFARule {
  path: string;
  maxAgeSeconds?: number;
  requireFresh?: boolean;
}

/** Reason the gate rejected. Mirrors the wire `reason` field. */
export type MFAGateReason = "no_mfa" | "stale_mfa" | "fresh_required";

export interface MiddlewareConfig {
  exemptPaths?: string[];
  /**
   * Paths that require MFA. A bare string is sugar for
   * `{ path, maxAgeSeconds: undefined }` — inherits the realm-default
   * window. Use the {@link MFARule} object form for per-route overrides.
   */
  mfaProtectedPaths?: Array<string | MFARule>;
  /**
   * Realm-wide default freshness window (in seconds) applied to bare-string
   * entries in `mfaProtectedPaths` and to `MFARule` entries that omit
   * `maxAgeSeconds`. Default 900 (15 min). Mirrors
   * `realms.config.mfa_session_ttl_seconds` server-side.
   */
  mfaDefaultMaxAgeSeconds?: number;
  loginPath?: string;
  logoutPath?: string;
  refreshPath?: string;
  mfaVerifyPath?: string;
  /** "cookie" (default, browser SPAs) or "body" (native/mobile clients). */
  tokenDelivery?: "cookie" | "body";
  cookieName?: string;
  cookieDomain?: string;
  cookieSecure?: boolean;
  cookieSameSite?: "lax" | "strict" | "none";
  /** Override the default 401/412 response. */
  onAuthFailure?: (req: ConnectReq, err: RealmError) => void | Promise<void>;
  /** Logger override; falls back to the realm handle's logger. */
  logger?: Logger;
}

interface NormalizedMFARule {
  path: string;
  maxAgeSeconds?: number;
  requireFresh: boolean;
}

/** Window (seconds) within which a `requireFresh: true` route accepts mfa_at. */
const REQUIRE_FRESH_WINDOW_SECONDS = 30;
/** Default freshness window when neither rule nor config specifies one. */
const DEFAULT_MFA_MAX_AGE_SECONDS = 900;

interface IncomingMessageLike {
  url?: string | undefined;
  method?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  body?: unknown;
}

interface ServerResponseLike {
  statusCode: number;
  setHeader(name: string, value: string | string[] | number): unknown;
  getHeader?(name: string): string | string[] | number | undefined;
  end(chunk?: string): unknown;
  writeHead?(status: number, headers?: Record<string, string | string[] | number>): unknown;
  headersSent?: boolean;
}

export type ConnectReq = IncomingMessageLike & { realmid?: Claims };
export type ConnectRes = ServerResponseLike;
export type NextFn = (err?: unknown) => void;

export type ConnectMiddleware = (
  req: ConnectReq,
  res: ConnectRes,
  next: NextFn,
) => void | Promise<void>;

interface Resolved {
  exemptPaths: string[];
  mfaRules: NormalizedMFARule[];
  mfaDefaultMaxAgeSeconds: number;
  loginPath: string;
  logoutPath: string;
  refreshPath: string;
  mfaVerifyPath: string;
  tokenDelivery: "cookie" | "body";
  cookieName: string;
  cookieDomain?: string;
  cookieSecure: boolean;
  cookieSameSite: "lax" | "strict" | "none";
}

function normalizeMfaRule(entry: string | MFARule): NormalizedMFARule {
  if (typeof entry === "string") {
    return { path: entry, requireFresh: false };
  }
  return {
    path: entry.path,
    maxAgeSeconds: entry.maxAgeSeconds,
    requireFresh: entry.requireFresh ?? false,
  };
}

export function createMiddleware(realm: Realm, cfg: MiddlewareConfig = {}): ConnectMiddleware {
  const merged: Resolved = {
    exemptPaths: cfg.exemptPaths ?? ["/health", "/public/*"],
    mfaRules: (cfg.mfaProtectedPaths ?? []).map(normalizeMfaRule).map((r) => {
      globMatch(r.path, "/", { braces: true }); // refuse a malformed `{...}` at construction
      return r;
    }),
    mfaDefaultMaxAgeSeconds: cfg.mfaDefaultMaxAgeSeconds ?? DEFAULT_MFA_MAX_AGE_SECONDS,
    loginPath: cfg.loginPath ?? "/login",
    logoutPath: cfg.logoutPath ?? "/logout",
    refreshPath: cfg.refreshPath ?? "/token",
    mfaVerifyPath: cfg.mfaVerifyPath ?? "/mfa/verify",
    tokenDelivery: cfg.tokenDelivery ?? realm.tokenDelivery,
    cookieName: cfg.cookieName ?? "realmid_refresh",
    cookieDomain: cfg.cookieDomain,
    cookieSecure: cfg.cookieSecure ?? true,
    cookieSameSite: cfg.cookieSameSite ?? "lax",
  };
  const onFail = cfg.onAuthFailure;
  const logger: Logger = cfg.logger ?? NOOP_LOGGER;

  return async function realmidMiddleware(req, res, next) {
    try {
      const path = pathOnly(req.url ?? "/");
      const method = (req.method ?? "GET").toUpperCase();

      // 1. Exempt path?
      for (const pat of merged.exemptPaths) {
        if (globMatch(pat, path)) {
          return next();
        }
      }

      // 2-5. Auth ingress routes.
      if (method === "POST" && path === merged.loginPath) {
        return void await handleLogin(realm, req, res, merged);
      }
      if (method === "POST" && path === merged.logoutPath) {
        return void await handleLogout(realm, req, res, merged);
      }
      if (method === "POST" && path === merged.refreshPath) {
        return void await handleRefresh(realm, req, res, merged);
      }
      if (method === "POST" && path === merged.mfaVerifyPath) {
        return void await handleMfaVerify(realm, req, res, merged);
      }

      // 6. Bearer verification fall-through.
      const auth = headerStr(req.headers["authorization"]);
      if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
        const err = new RealmError({
          code: "unauthorized",
          message: "missing bearer token",
          httpStatus: 401,
        });
        logger.warn("realmid: auth failure", { path, code: err.code });
        return void await respondAuthFailure(res, err, req, onFail);
      }
      const token = auth.slice("bearer ".length).trim();
      let claims: Claims;
      try {
        claims = await realm.verify(token);
      } catch (e) {
        const err = e instanceof RealmError
          ? e
          : new RealmError({ code: "unauthorized", message: (e as Error).message ?? "verify failed", cause: e });
        logger.warn("realmid: auth failure", { path, code: err.code });
        return void await respondAuthFailure(res, err, req, onFail);
      }

      // 6a (SPEC §10.1): the §6.7 logout / superseded check, on the realm's own
      // TokensClient, before the MFA check and before claims are attached. A
      // revoked token on an MFA-protected route is a 401, never the 412.
      try {
        await realm.tokens.gateRequest(token);
      } catch (e) {
        const err = e instanceof RealmError ? e : new RealmError({ code: "unauthorized", message: "access token revoked", cause: e });
        logger.warn("realmid: auth failure", { path, code: err.code });
        return void await respondAuthFailure(res, err, req, onFail);
      }

      // MFA gating (SPEC §10.1, §10.4).
      if (merged.mfaRules.length > 0) {
        const rule = findMfaRule(merged.mfaRules, path);
        if (rule) {
          const verdict = evaluateMfaFreshness(claims, rule, merged.mfaDefaultMaxAgeSeconds);
          if (verdict !== null) {
            await respondMfaRequired(realm, res, token, verdict.reason, verdict.maxAgeSeconds, logger);
            return;
          }
        }
      }

      req.realmid = claims;
      return next();
    } catch (e) {
      next(e);
    }
  };
}

// ---- route handlers ----

async function handleLogin(realm: Realm, req: ConnectReq, res: ConnectRes, cfg: Resolved) {
  const body = await readJsonBody(req);
  const loginReq: LoginRequest = {
    method: (body["method"] as LoginRequest["method"]) ?? "firebase",
    providerToken: String(body["provider_token"] ?? body["providerToken"] ?? ""),
  };
  try {
    const out = await realm.auth.login(loginReq);
    finishSession(res, cfg, out, await realm.orgSessionMode());
  } catch (e) {
    if (e instanceof RealmError && e.code === "mfa_required") {
      const d = e.details ?? {};
      sendJson(res, 200, {
        status: "mfa_required",
        mfa_challenge_token: d["mfa_challenge_token"],
        methods: d["methods"] ?? d["mfa_methods"],
      });
      return;
    }
    sendError(res, e);
  }
}

async function handleLogout(realm: Realm, req: ConnectReq, res: ConnectRes, cfg: Resolved) {
  const refreshToken = readRefreshToken(req, cfg);
  // §10.1 step 3a: `auth.logout` revokes the session the ISSUER names; the
  // bearer is only the fallback, and is VERIFIED there (expiry included).
  const auth = headerStr(req.headers["authorization"]);
  const accessToken = auth && auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : undefined;
  try {
    await realm.auth.logout({ refreshToken, accessToken });
  } catch {
    // best-effort logout — clear cookie regardless; logout never 401s
  }
  if (cfg.tokenDelivery === "cookie") {
    clearRefreshCookie(res, cfg);
  }
  sendJson(res, 200, { status: "ok" });
}

const LOCK_TTL_MS = 10_000;
const OUTCOME_TTL_MS = 5_000;
const MINT_BOUND_MS = 10_000;
const POLL_MS = 50;
const POLL_TRIES = 60;
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What a winner stores for losers (SPEC §10.1 step 4a). Holds live credentials: 5 s TTL, secret. */
interface RefreshOutcome {
  fp: string;
  ok: boolean;
  /** The refresh token the winner's response hands out. */
  refreshToken?: string;
  mint?: { accessToken: string; expiresIn: number; tenantId: string; role: string };
  mode?: string;
  status?: number;
  body?: unknown;
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stableJson(o[k])).join(",") + "}";
}

function errorOutcome(fp: string, e: unknown): RefreshOutcome {
  if (e instanceof RealmError) {
    return { fp, ok: false, status: e.httpStatus ?? 500, body: { error: { code: e.code, message: e.message }, ...(e.details ?? {}) } };
  }
  return { fp, ok: false, status: 500, body: { error: { code: "server_error", message: (e as Error).message ?? "unknown" } } };
}

function send503(res: ConnectRes, message: string, extra: Record<string, unknown> = {}): void {
  sendJson(res, 503, { error: { code: "server_error", message }, ...extra });
}

/** Hands over a rotated refresh token exactly as a winner's response does. */
function handOver(res: ConnectRes, cfg: Resolved, refreshToken: string | undefined): Record<string, unknown> {
  if (!refreshToken) return {};
  if (cfg.tokenDelivery === "cookie") {
    setRefreshCookie(res, cfg, refreshToken);
    return {};
  }
  return { refresh_token: refreshToken };
}

function respondOutcome(res: ConnectRes, cfg: Resolved, fp: string, o: RefreshOutcome): void {
  if (!o.ok) {
    sendJson(res, o.status ?? 500, o.body);
    return;
  }
  if (o.fp !== fp) {
    // Different request than the winner's (tenant, custom_claims, or an MFA
    // verify): the loser does NOT mint. Both responses set the SAME token.
    send503(res, "refresh superseded, retry", { retry: true, ...handOver(res, cfg, o.refreshToken) });
    return;
  }
  const m = o.mint!;
  const base = { access_token: m.accessToken, expires_in: m.expiresIn, tenant_id: m.tenantId, role: m.role };
  if (cfg.tokenDelivery === "cookie") {
    setRefreshCookie(res, cfg, o.refreshToken ?? "");
    sendJson(res, 200, { ...base, org_session_mode: o.mode });
  } else {
    sendJson(res, 200, {
      access_token: m.accessToken, refresh_token: o.refreshToken, expires_in: m.expiresIn,
      tenant_id: m.tenantId, role: m.role, org_session_mode: o.mode,
    });
  }
}

async function readOutcome(store: Realm["sessionStore"], key: string): Promise<RefreshOutcome | undefined> {
  const raw = await store.getRefreshResult(key);
  return raw === undefined ? undefined : (JSON.parse(raw) as RefreshOutcome);
}

async function handleRefresh(realm: Realm, req: ConnectReq, res: ConnectRes, cfg: Resolved) {
  const body = await readJsonBody(req).catch(() => ({} as Record<string, unknown>));
  const refreshToken = readRefreshToken(req, cfg, body);
  if (!refreshToken) {
    sendError(res, new RealmError({
      code: "unauthorized",
      message: cfg.tokenDelivery === "cookie" ? "refresh cookie missing" : "refresh_token missing from body",
      httpStatus: 401,
    }));
    return;
  }
  const tenantId = String(body["tenant_id"] ?? body["tenantId"] ?? "");
  if (!tenantId) {
    sendError(res, new RealmError({ code: "tenant_required", message: "tenant_id required", httpStatus: 400 }));
    return;
  }
  const customClaims = (body["custom_claims"] ?? body["customClaims"]) as Record<string, unknown> | undefined;
  const fp = tenantId + "\u0000" + stableJson(customClaims ?? null);
  const store = realm.sessionStore;
  const lk = await lockKey(refreshToken);
  const ok = await outKey(refreshToken);

  let lock;
  try {
    lock = await store.acquireRefreshLock(lk, LOCK_TTL_MS);
  } catch {
    return send503(res, "session store unavailable");
  }

  try {
    if (!lock.acquired) {
      // Loser: wait for the winner's outcome (50 ms x 60).
      for (let i = 0; i < POLL_TRIES; i++) {
        const o = await readOutcome(store, ok).catch(() => undefined);
        if (o) return respondOutcome(res, cfg, fp, o);
        await sleepMs(POLL_MS);
      }
      return send503(res, "refresh in progress");
    }
    // Winner. A request that lost the previous winner's response gets its outcome.
    const prior = await readOutcome(store, ok).catch(() => undefined);
    if (prior) return respondOutcome(res, cfg, fp, prior);

    const outcome = await mintBounded(realm, refreshToken, tenantId, customClaims, fp);
    await store.putRefreshResult(ok, JSON.stringify(outcome), OUTCOME_TTL_MS).catch(() => undefined);
    // §10.1 step 4b: only a ROTATING refresh supersedes older tokens; compare
    // against the candidate that MINTED. A loser never reaches here.
    if (outcome.ok && outcome.refreshToken && outcome.refreshToken !== refreshToken && outcome.mint) {
      await realm.tokens.recordRefresh(outcome.mint.accessToken);
    }
    respondOutcome(res, cfg, fp, outcome);
  } finally {
    await lock.release().catch(() => undefined);
  }
}

/** The mint runs independent of the request and is bounded at 10 s. */
async function mintBounded(
  realm: Realm,
  refreshToken: string,
  tenantId: string,
  customClaims: Record<string, unknown> | undefined,
  fp: string,
): Promise<RefreshOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = (async (): Promise<RefreshOutcome> => {
    const out = await realm.auth.token({ refreshToken, tenantId, customClaims });
    // The derived claims (ADR-102 `product_roles`, ADR-097 `scope`) are resolved
    // PER MINT, and a refresh is a mint — see derived-claims-refresh.ts.
    await realm.auth.enrichRefresh(out, tenantId);
    return {
      fp, ok: true, refreshToken: out.refreshToken, mode: await realm.orgSessionMode(),
      mint: { accessToken: out.accessToken, expiresIn: out.expiresIn, tenantId: out.tenantId, role: out.role },
    } as RefreshOutcome;
  })();
  const bound = new Promise<RefreshOutcome>((resolve) => {
    timer = setTimeout(() => resolve(errorOutcome(fp, new RealmError({ code: "server_error", message: "refresh timed out", httpStatus: 504 }))), MINT_BOUND_MS);
  });
  try {
    return await Promise.race([run.catch((e) => errorOutcome(fp, e)), bound]);
  } finally {
    clearTimeout(timer);
  }
}

async function handleMfaVerify(realm: Realm, req: ConnectReq, res: ConnectRes, cfg: Resolved) {
  const body = await readJsonBody(req);
  const challengeToken = String(body["mfa_challenge_token"] ?? body["challenge_token"] ?? body["challengeToken"] ?? "");
  const code = String(body["code"] ?? "");
  // SPEC §10.1 step 5: a verify that carries a refresh-token candidate ROTATES
  // that session's token, so it runs under the same lock. It never adopts a
  // refresh outcome (its challenge is single-use) — it waits for the lock itself.
  const candidate = readRefreshToken(req, cfg, body);
  let release: (() => Promise<void>) | undefined;
  if (candidate) {
    const lk = await lockKey(candidate);
    for (let i = 0; ; i++) {
      let l;
      try {
        l = await realm.sessionStore.acquireRefreshLock(lk, LOCK_TTL_MS);
      } catch {
        return send503(res, "session store unavailable");
      }
      if (l.acquired) { release = l.release; break; }
      if (i + 1 >= POLL_TRIES) return send503(res, "refresh in progress");
      await sleepMs(POLL_MS);
    }
  }
  try {
    const out = await realm.auth.mfaVerify({ challengeToken, code });
    if (candidate) {
      const o: RefreshOutcome = { fp: "mfa-verify", ok: true, refreshToken: out.refreshToken };
      await realm.sessionStore.putRefreshResult(await outKey(candidate), JSON.stringify(o), OUTCOME_TTL_MS).catch(() => undefined);
    }
    finishSession(res, cfg, out, await realm.orgSessionMode());
  } catch (e) {
    sendError(res, e);
  } finally {
    await release?.().catch(() => undefined);
  }
}

interface SessionEnvelope {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: unknown;
  tenants: unknown;
}

function finishSession(res: ConnectRes, cfg: Resolved, out: SessionEnvelope, orgSessionMode: string): void {
  if (cfg.tokenDelivery === "cookie") {
    setRefreshCookie(res, cfg, out.refreshToken);
    sendJson(res, 200, {
      access_token: out.accessToken,
      expires_in: out.expiresIn,
      user: out.user,
      tenants: out.tenants,
      org_session_mode: orgSessionMode,
    });
  } else {
    sendJson(res, 200, {
      access_token: out.accessToken,
      refresh_token: out.refreshToken,
      expires_in: out.expiresIn,
      user: out.user,
      tenants: out.tenants,
      org_session_mode: orgSessionMode,
    });
  }
}

function readRefreshToken(req: ConnectReq, cfg: Resolved, body?: Record<string, unknown>): string | undefined {
  if (cfg.tokenDelivery === "cookie") return readCookie(req, cfg.cookieName);
  if (body && typeof body["refresh_token"] === "string") return body["refresh_token"] as string;
  if (body && typeof body["refreshToken"] === "string") return body["refreshToken"] as string;
  return undefined;
}

function findMfaRule(rules: NormalizedMFARule[], path: string): NormalizedMFARule | undefined {
  for (const r of rules) {
    if (globMatch(r.path, path, { braces: true })) return r;
  }
  return undefined;
}

/** Source of the MFA proof: explicit timestamp, legacy marker, or absent. */
type MfaProofSource = "mfa_at" | "marker_fallback" | "none";

interface MfaProof {
  /** Effective mfa_at (unix-seconds). Set to "now" when only the legacy marker is present. */
  at: number;
  source: MfaProofSource;
}

/**
 * Read MFA proof from claims, with a backward-compat fallback:
 *  - explicit `mfa_at` → use it (source "mfa_at").
 *  - legacy `amr` ⊇ `["mfa"]` or `acr === "urn:realmid:mfa"` → treat as
 *    if minted now (source "marker_fallback"). Lets pre-mfa_at servers
 *    keep passing maxAge gates; `requireFresh` still rejects because we
 *    don't know how fresh the MFA actually was.
 *  - neither → source "none".
 */
function readMfaProof(claims: Claims): MfaProof {
  const v = (claims as Record<string, unknown>)["mfa_at"];
  let at = 0;
  if (typeof v === "number" && Number.isFinite(v)) at = v;
  else if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) at = n;
  }
  if (at > 0) return { at, source: "mfa_at" };

  const amr = (claims as Record<string, unknown>)["amr"];
  const acr = (claims as Record<string, unknown>)["acr"];
  const hasMarker =
    (Array.isArray(amr) && amr.includes("mfa")) ||
    acr === "urn:realmid:mfa";
  if (hasMarker) return { at: Math.floor(Date.now() / 1000), source: "marker_fallback" };

  return { at: 0, source: "none" };
}

interface MfaVerdict {
  reason: MFAGateReason;
  maxAgeSeconds: number;
}

/**
 * Evaluate whether `claims` carries fresh-enough MFA proof for `rule`.
 * Returns `null` when the gate passes; an `MfaVerdict` describing the
 * failure mode and the window the client has to satisfy when it fails.
 */
function evaluateMfaFreshness(
  claims: Claims,
  rule: NormalizedMFARule,
  defaultMaxAgeSeconds: number,
): MfaVerdict | null {
  const proof = readMfaProof(claims);
  const nowSec = Math.floor(Date.now() / 1000);
  const age = nowSec - proof.at;

  // requireFresh requires an explicit mfa_at claim — the legacy marker
  // carries no timestamp, so we can't prove freshness from it.
  if (rule.requireFresh) {
    if (proof.source === "mfa_at" && age <= REQUIRE_FRESH_WINDOW_SECONDS) return null;
    return { reason: "fresh_required", maxAgeSeconds: 0 };
  }

  const maxAge = rule.maxAgeSeconds ?? defaultMaxAgeSeconds;
  // maxAge of 0 collapses to "fresh required" semantics.
  if (maxAge <= 0) {
    if (proof.source === "mfa_at" && age <= REQUIRE_FRESH_WINDOW_SECONDS) return null;
    return { reason: proof.source === "none" ? "no_mfa" : "stale_mfa", maxAgeSeconds: 0 };
  }

  if (proof.source === "none") return { reason: "no_mfa", maxAgeSeconds: maxAge };
  // marker_fallback yields age = 0; mfa_at within window also passes.
  if (age > maxAge) return { reason: "stale_mfa", maxAgeSeconds: maxAge };
  return null;
}

async function respondMfaRequired(
  realm: Realm,
  res: ConnectRes,
  accessToken: string,
  reason: MFAGateReason,
  maxAgeSeconds: number,
  logger: Logger,
): Promise<void> {
  let challenge: { mfaChallengeToken: string; methods: string[] } | undefined;
  try {
    challenge = await realm.auth.mintMfaChallenge({ accessToken });
  } catch (e) {
    logger.warn("realmid: mfa challenge mint unavailable", {
      message: (e as Error).message,
    });
  }
  sendJson(res, 412, {
    error: { code: "mfa_required", message: "MFA required for this resource" },
    mfa_challenge_token: challenge?.mfaChallengeToken,
    methods: challenge?.methods ?? ["totp"],
    max_age_seconds: maxAgeSeconds,
    reason,
  });
}

// ---- response helpers ----

async function respondAuthFailure(res: ConnectRes, err: RealmError, req: ConnectReq, hook?: MiddlewareConfig["onAuthFailure"]) {
  if (hook) {
    await hook(req, err);
    return;
  }
  const revoked = err.details?.["revoked"] === true;
  sendJson(res, err.httpStatus ?? 401, {
    error: { code: err.code, message: err.message },
    ...(revoked ? { revoked: true } : {}),
  });
}

function sendJson(res: ConnectRes, status: number, body: unknown): void {
  if (!res.headersSent) {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
  }
  res.end(JSON.stringify(body));
}

function sendError(res: ConnectRes, err: unknown): void {
  if (err instanceof RealmError) {
    sendJson(res, err.httpStatus ?? 500, {
      error: { code: err.code, message: err.message },
      ...(err.details ?? {}),
    });
    return;
  }
  sendJson(res, 500, {
    error: { code: "server_error", message: (err as Error).message ?? "unknown" },
  });
}

// ---- cookie helpers ----

function setRefreshCookie(res: ConnectRes, cfg: Resolved, value: string) {
  const parts = [
    `${cfg.cookieName}=${encodeURIComponent(value)}`,
    "HttpOnly",
    `SameSite=${sameSiteToken(cfg.cookieSameSite)}`,
    "Path=/",
  ];
  if (cfg.cookieSecure) parts.push("Secure");
  if (cfg.cookieDomain) parts.push(`Domain=${cfg.cookieDomain}`);
  appendSetCookie(res, parts.join("; "));
}

function clearRefreshCookie(res: ConnectRes, cfg: Resolved) {
  const parts = [
    `${cfg.cookieName}=`,
    "HttpOnly",
    `SameSite=${sameSiteToken(cfg.cookieSameSite)}`,
    "Path=/",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (cfg.cookieSecure) parts.push("Secure");
  if (cfg.cookieDomain) parts.push(`Domain=${cfg.cookieDomain}`);
  appendSetCookie(res, parts.join("; "));
}

function sameSiteToken(s: "lax" | "strict" | "none"): string {
  if (s === "strict") return "Strict";
  if (s === "none") return "None";
  return "Lax";
}

function appendSetCookie(res: ConnectRes, cookie: string) {
  const existing = res.getHeader?.("set-cookie");
  if (!existing) {
    res.setHeader("set-cookie", cookie);
    return;
  }
  if (Array.isArray(existing)) {
    res.setHeader("set-cookie", [...existing, cookie]);
  } else {
    res.setHeader("set-cookie", [String(existing), cookie]);
  }
}

function readCookie(req: ConnectReq, name: string): string | undefined {
  const raw = headerStr(req.headers["cookie"]);
  if (!raw) return undefined;
  for (const pair of raw.split(/;\s*/)) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const k = pair.slice(0, eq);
    const v = pair.slice(eq + 1);
    if (k === name) return decodeURIComponent(v);
  }
  return undefined;
}

// ---- request helpers ----

async function readJsonBody(req: IncomingMessageLike): Promise<Record<string, unknown>> {
  if (req.body && typeof req.body === "object") {
    return req.body as Record<string, unknown>;
  }
  // Pull from stream if available (raw http).
  if (typeof req.on !== "function") return {};
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    req.on!("data", (c: unknown) => {
      if (c instanceof Uint8Array) chunks.push(c);
      else if (typeof c === "string") chunks.push(new TextEncoder().encode(c));
      else chunks.push(new TextEncoder().encode(String(c)));
    });
    req.on!("end", () => {
      let total = 0;
      for (const c of chunks) total += c.byteLength;
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
      const text = new TextDecoder().decode(merged);
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch (e) {
        reject(e);
      }
    });
    req.on!("error", reject);
  });
}

function headerStr(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function pathOnly(url: string): string {
  const q = url.indexOf("?");
  return q < 0 ? url : url.slice(0, q);
}

// ---- glob matcher ----

/**
 * Tiny glob matcher. Supports `*` (one segment), `**` (zero or more
 * segments). No braces, no character classes — partners can use multiple
 * patterns if they need an alternation.
 */
export function globMatch(pattern: string, path: string, opts: { braces?: boolean } = {}): boolean {
  return globToRegex(pattern, opts.braces === true).test(path);
}

/**
 * `braces: true` (mfaProtectedPaths, ScopeRule paths — SPEC §10.2 / §11.4.1)
 * turns a WHOLE-SEGMENT `{name}` into one non-empty segment (`[^/]+`); any
 * other brace form throws. `exemptPaths` keeps the default (braces literal): a
 * placeholder there would widen an exemption, the fail-open direction.
 * `/x/**` matches the bare `/x` (v0.63.0, BREAKING vs v0.62).
 */
function globToRegex(pat: string, braces = false): RegExp {
  if (braces) assertBracesWellFormed(pat);
  let re = "^";
  let i = 0;
  while (i < pat.length) {
    const c = pat[i]!;
    if (c === "/" && pat[i + 1] === "*" && pat[i + 2] === "*" && (i + 3 === pat.length || pat[i + 3] === "/")) {
      // `/**` = zero or more segments, so it also matches the bare prefix.
      re += "(?:/.*)?";
      i += 3;
      // A following "/" belongs to the segments the group already spans.
      if (pat[i] === "/") i++;
    } else if (c === "*" && pat[i + 1] === "*") {
      re += ".*";
      i += 2;
      if (pat[i] === "/") i++;
    } else if (c === "*") {
      re += "[^/]*";
      i++;
    } else if (braces && c === "{") {
      const close = pat.indexOf("}", i);
      re += "[^/]+";
      i = close + 1;
    } else if (/[.+?^${}()|[\]\\]/.test(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}

/** SPEC §11.4.1 grammar: `{name}` must be a whole segment, name = 1*(ALPHA/DIGIT/_/-). */
function assertBracesWellFormed(pat: string): void {
  if (!/[{}]/.test(pat)) return;
  for (const seg of pat.split("/")) {
    if (!/[{}]/.test(seg)) continue;
    if (!/^\{[A-Za-z0-9_-]+\}$/.test(seg)) {
      throw new RealmError({
        code: "invalid_config",
        message: `realmid: path "${pat}": "{name}" must be a whole path segment (name = letters, digits, _ or -)`,
      });
    }
  }
}
