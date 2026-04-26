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

export interface MiddlewareConfig {
  exemptPaths?: string[];
  /** Globs for paths that require an MFA-marked access token. */
  mfaProtectedPaths?: string[];
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
  mfaProtectedPaths: string[];
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

export function createMiddleware(realm: Realm, cfg: MiddlewareConfig = {}): ConnectMiddleware {
  const merged: Resolved = {
    exemptPaths: cfg.exemptPaths ?? ["/health", "/public/*"],
    mfaProtectedPaths: cfg.mfaProtectedPaths ?? [],
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

      // MFA gating (SPEC §10.1).
      if (merged.mfaProtectedPaths.length > 0 && pathRequiresMfa(merged.mfaProtectedPaths, path)) {
        if (!claimsCarryMfa(claims)) {
          await respondMfaRequired(realm, res, token, logger);
          return;
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
    finishSession(res, cfg, out);
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
  try {
    await realm.auth.logout({ refreshToken });
  } catch {
    // best-effort logout — clear cookie regardless
  }
  if (cfg.tokenDelivery === "cookie") {
    clearRefreshCookie(res, cfg);
  }
  sendJson(res, 200, { status: "ok" });
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
  try {
    const out = await realm.auth.token({ refreshToken, tenantId, customClaims });
    if (cfg.tokenDelivery === "cookie") {
      setRefreshCookie(res, cfg, out.refreshToken);
      sendJson(res, 200, {
        access_token: out.accessToken,
        expires_in: out.expiresIn,
        tenant_id: out.tenantId,
        role: out.role,
      });
    } else {
      sendJson(res, 200, {
        access_token: out.accessToken,
        refresh_token: out.refreshToken,
        expires_in: out.expiresIn,
        tenant_id: out.tenantId,
        role: out.role,
      });
    }
  } catch (e) {
    sendError(res, e);
  }
}

async function handleMfaVerify(realm: Realm, req: ConnectReq, res: ConnectRes, cfg: Resolved) {
  const body = await readJsonBody(req);
  const challengeToken = String(body["challenge_token"] ?? body["challengeToken"] ?? "");
  const code = String(body["code"] ?? "");
  try {
    const out = await realm.auth.mfaVerify({ challengeToken, code });
    finishSession(res, cfg, out);
  } catch (e) {
    sendError(res, e);
  }
}

interface SessionEnvelope {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: unknown;
  tenants: unknown;
}

function finishSession(res: ConnectRes, cfg: Resolved, out: SessionEnvelope): void {
  if (cfg.tokenDelivery === "cookie") {
    setRefreshCookie(res, cfg, out.refreshToken);
    sendJson(res, 200, {
      access_token: out.accessToken,
      expires_in: out.expiresIn,
      user: out.user,
      tenants: out.tenants,
    });
  } else {
    sendJson(res, 200, {
      access_token: out.accessToken,
      refresh_token: out.refreshToken,
      expires_in: out.expiresIn,
      user: out.user,
      tenants: out.tenants,
    });
  }
}

function readRefreshToken(req: ConnectReq, cfg: Resolved, body?: Record<string, unknown>): string | undefined {
  if (cfg.tokenDelivery === "cookie") return readCookie(req, cfg.cookieName);
  if (body && typeof body["refresh_token"] === "string") return body["refresh_token"] as string;
  if (body && typeof body["refreshToken"] === "string") return body["refreshToken"] as string;
  return undefined;
}

function pathRequiresMfa(patterns: string[], path: string): boolean {
  for (const p of patterns) {
    if (globMatch(p, path)) return true;
  }
  return false;
}

function claimsCarryMfa(claims: Claims): boolean {
  const amr = (claims as Record<string, unknown>)["amr"];
  if (Array.isArray(amr) && amr.includes("mfa")) return true;
  const acr = (claims as Record<string, unknown>)["acr"];
  if (acr === "urn:realmid:mfa") return true;
  return false;
}

async function respondMfaRequired(realm: Realm, res: ConnectRes, accessToken: string, logger: Logger): Promise<void> {
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
  });
}

// ---- response helpers ----

async function respondAuthFailure(res: ConnectRes, err: RealmError, req: ConnectReq, hook?: MiddlewareConfig["onAuthFailure"]) {
  if (hook) {
    await hook(req, err);
    return;
  }
  sendJson(res, err.httpStatus ?? 401, { error: { code: err.code, message: err.message } });
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
export function globMatch(pattern: string, path: string): boolean {
  const re = globToRegex(pattern);
  return re.test(path);
}

function globToRegex(pat: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < pat.length) {
    const c = pat[i]!;
    if (c === "*" && pat[i + 1] === "*") {
      re += ".*";
      i += 2;
      // optional trailing slash absorbed
      if (pat[i] === "/") i++;
    } else if (c === "*") {
      re += "[^/]*";
      i++;
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
