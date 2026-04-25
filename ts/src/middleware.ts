/**
 * Connect-style middleware — SPEC §11.
 *
 * One handler that routes the four auth ingress paths
 * (login/logout/refresh/mfa-verify) to the SDK and falls through to bearer
 * verification for everything else. Designed to mount on Express, Polka, or
 * raw http with no extra dependencies.
 */

import type { Realm } from "./realm.js";
import { RealmError } from "./errors.js";
import type { Claims } from "./claims.js";
import type { LoginRequest } from "./auth.js";

export interface MiddlewareConfig {
  exemptPaths?: string[];
  loginPath?: string;
  logoutPath?: string;
  refreshPath?: string;
  mfaVerifyPath?: string;
  cookieName?: string;
  cookieDomain?: string;
  cookieSecure?: boolean;
  /** Override the default 401 response. */
  onAuthFailure?: (req: ConnectReq, err: RealmError) => void | Promise<void>;
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

const DEFAULTS: Required<Omit<MiddlewareConfig, "cookieDomain" | "onAuthFailure">> = {
  exemptPaths: ["/health", "/public/*"],
  loginPath: "/login",
  logoutPath: "/logout",
  refreshPath: "/token",
  mfaVerifyPath: "/mfa/verify",
  cookieName: "realmid_refresh",
  cookieSecure: true,
};

export function createMiddleware(realm: Realm, cfg: MiddlewareConfig = {}): ConnectMiddleware {
  const merged = { ...DEFAULTS, ...cfg };
  const cookieDomain = cfg.cookieDomain;
  const onFail = cfg.onAuthFailure;

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
        return void await handleLogin(realm, req, res, merged, cookieDomain);
      }
      if (method === "POST" && path === merged.logoutPath) {
        return void await handleLogout(realm, req, res, merged, cookieDomain);
      }
      if (method === "POST" && path === merged.refreshPath) {
        return void await handleRefresh(realm, req, res, merged, cookieDomain);
      }
      if (method === "POST" && path === merged.mfaVerifyPath) {
        return void await handleMfaVerify(realm, req, res, merged, cookieDomain);
      }

      // 6. Bearer verification fall-through.
      const auth = headerStr(req.headers["authorization"]);
      if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
        const err = new RealmError({
          code: "unauthorized",
          message: "missing bearer token",
          httpStatus: 401,
        });
        return void await respondAuthFailure(res, err, req, onFail);
      }
      const token = auth.slice("bearer ".length).trim();
      try {
        const claims = await realm.verify(token);
        req.realmid = claims;
        return next();
      } catch (e) {
        const err = e instanceof RealmError
          ? e
          : new RealmError({ code: "unauthorized", message: (e as Error).message ?? "verify failed", cause: e });
        return void await respondAuthFailure(res, err, req, onFail);
      }
    } catch (e) {
      next(e);
    }
  };
}

// ---- route handlers ----

async function handleLogin(realm: Realm, req: ConnectReq, res: ConnectRes, cfg: typeof DEFAULTS, cookieDomain?: string) {
  const body = await readJsonBody(req);
  const loginReq: LoginRequest = {
    method: (body["method"] as LoginRequest["method"]) ?? "firebase",
    providerToken: String(body["provider_token"] ?? body["providerToken"] ?? ""),
    customClaims: (body["custom_claims"] ?? body["customClaims"]) as Record<string, unknown> | undefined,
  };
  try {
    const out = await realm.auth.login(loginReq);
    setRefreshCookie(res, cfg.cookieName, out.refreshToken, cfg.cookieSecure, cookieDomain);
    sendJson(res, 200, {
      access_token: out.accessToken,
      expires_in: out.expiresIn,
      user: out.user,
      tenants: out.tenants,
    });
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

async function handleLogout(realm: Realm, req: ConnectReq, res: ConnectRes, cfg: typeof DEFAULTS, cookieDomain?: string) {
  const refreshToken = readCookie(req, cfg.cookieName);
  try {
    await realm.auth.logout({ refreshToken });
  } catch {
    // best-effort logout — clear cookie regardless
  }
  clearRefreshCookie(res, cfg.cookieName, cfg.cookieSecure, cookieDomain);
  sendJson(res, 200, { status: "ok" });
}

async function handleRefresh(realm: Realm, req: ConnectReq, res: ConnectRes, cfg: typeof DEFAULTS, cookieDomain?: string) {
  const refreshToken = readCookie(req, cfg.cookieName);
  if (!refreshToken) {
    sendError(res, new RealmError({ code: "unauthorized", message: "refresh cookie missing", httpStatus: 401 }));
    return;
  }
  const body = await readJsonBody(req).catch(() => ({} as Record<string, unknown>));
  const tenantId = String((body as Record<string, unknown>)["tenant_id"] ?? (body as Record<string, unknown>)["tenantId"] ?? "");
  if (!tenantId) {
    sendError(res, new RealmError({ code: "tenant_required", message: "tenant_id required", httpStatus: 400 }));
    return;
  }
  try {
    const out = await realm.auth.token({ refreshToken, tenantId });
    setRefreshCookie(res, cfg.cookieName, out.refreshToken, cfg.cookieSecure, cookieDomain);
    sendJson(res, 200, {
      access_token: out.accessToken,
      expires_in: out.expiresIn,
      tenant_id: out.tenantId,
      role: out.role,
    });
  } catch (e) {
    sendError(res, e);
  }
}

async function handleMfaVerify(realm: Realm, req: ConnectReq, res: ConnectRes, cfg: typeof DEFAULTS, cookieDomain?: string) {
  const body = await readJsonBody(req);
  const challengeToken = String(body["challenge_token"] ?? body["challengeToken"] ?? "");
  const code = String(body["code"] ?? "");
  try {
    const out = await realm.auth.mfaVerify({ challengeToken, code });
    setRefreshCookie(res, cfg.cookieName, out.refreshToken, cfg.cookieSecure, cookieDomain);
    sendJson(res, 200, {
      access_token: out.accessToken,
      expires_in: out.expiresIn,
      user: out.user,
      tenants: out.tenants,
    });
  } catch (e) {
    sendError(res, e);
  }
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

function setRefreshCookie(res: ConnectRes, name: string, value: string, secure: boolean, domain?: string) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
  ];
  if (secure) parts.push("Secure");
  if (domain) parts.push(`Domain=${domain}`);
  appendSetCookie(res, parts.join("; "));
}

function clearRefreshCookie(res: ConnectRes, name: string, secure: boolean, domain?: string) {
  const parts = [
    `${name}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (secure) parts.push("Secure");
  if (domain) parts.push(`Domain=${domain}`);
  appendSetCookie(res, parts.join("; "));
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
