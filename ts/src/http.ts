/**
 * Internal HTTP client. Wraps fetch and translates non-2xx responses + network
 * failures into RealmError. Server error envelopes are expected in the shape:
 *   { error: { code, message }, ...siblings }
 * where siblings (e.g. mfa_challenge_token) flow into RealmError.details.
 *
 * Authorization is sourced from a platform-token manager (SPEC §4.0):
 * every outbound request — including `auth.login` — uses the
 * short-lived platform token. The raw API key only travels on the
 * `POST /auth/platform-token` call inside `PlatformTokenManager`.
 */

import { RealmError, statusToCode, isKnownCode, type ErrorCode } from "./errors.js";
import type { Logger } from "./logger.js";
import { NOOP_LOGGER, redactCredential } from "./logger.js";
import type { PlatformTokenManager } from "./platform-token-manager.js";

export interface HttpClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  /**
   * Source of the platform token used for normal management/auth calls.
   * When omitted, requests go out unauthenticated (e.g. JWKS, public
   * info routes). Per-call `bearer` always wins.
   */
  platformTokens?: PlatformTokenManager;
  logger?: Logger;
  /**
   * The end user's *verified* access JWT, forwarded as `X-User-Token` on every
   * request this client makes (SPEC §4 verified on-behalf-of; ADR-056). Set by
   * `realm.withUserToken(jwt)` rather than directly: a client carrying a user
   * token is a DERIVED client, so a user's identity can never leak onto the
   * long-lived realm handle. A per-call `headers["x-user-token"]` still wins.
   */
  userToken?: string;
}

export interface RequestOptions {
  method?: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Per-call bearer override (e.g. user JWT for sessions endpoints). */
  bearer?: string;
  /** Extra headers (e.g. Origin) merged after defaults. */
  headers?: Record<string, string>;
  /**
   * Skip the platform-token mint for this call (used internally so the
   * manager itself doesn't recurse). Defaults to false.
   */
  skipPlatformToken?: boolean;
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly platformTokens?: PlatformTokenManager;
  private readonly logger: Logger;
  private readonly opts: HttpClientOptions;
  private readonly userToken?: string;

  constructor(opts: HttpClientOptions) {
    this.opts = opts;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.platformTokens = opts.platformTokens;
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.userToken = opts.userToken;
  }

  /**
   * Returns a COPY of this client that forwards `accessJWT` as `X-User-Token`.
   * The platform-token manager is shared, so the derived client reuses the
   * cached platform token instead of re-minting one per user.
   */
  withUserToken(accessJWT: string): HttpClient {
    return new HttpClient({ ...this.opts, userToken: accessJWT });
  }

  async request<T = unknown>(opts: RequestOptions): Promise<T> {
    const url = this.buildUrl(opts.path, opts.query);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "accept": "application/json",
    };

    let bearer = opts.bearer;
    if (!bearer && !opts.skipPlatformToken && this.platformTokens) {
      bearer = await this.platformTokens.getToken();
    }
    if (bearer) headers["authorization"] = `Bearer ${bearer}`;
    // The client-scoped user token is ADDITIVE — the platform token stays the
    // wire bearer (ADR-056). Set before the per-call merge so an explicit
    // header still wins. Per-call keys are lower-cased on the way in: `fetch`
    // treats header names case-insensitively and would otherwise APPEND a
    // differently-cased duplicate ("a, b") instead of overriding it.
    if (this.userToken) headers["x-user-token"] = this.userToken;
    if (opts.headers) {
      for (const [k, v] of Object.entries(opts.headers)) headers[k.toLowerCase()] = v;
    }

    const init: RequestInit = {
      method: opts.method ?? "GET",
      headers,
    };
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
    }

    this.logger.debug("realmid: outbound request", {
      method: init.method,
      path: opts.path,
      bearer: bearer ? redactCredential(bearer) : "<none>",
    });

    let resp: Response;
    try {
      resp = await this.fetch(url, init);
    } catch (e) {
      this.logger.error("realmid: network error", {
        method: init.method,
        path: opts.path,
        message: (e as Error).message,
      });
      throw new RealmError({
        code: "network",
        message: `network error calling ${opts.method ?? "GET"} ${opts.path}: ${(e as Error).message}`,
        cause: e,
      });
    }

    if (resp.status === 204) {
      this.logger.debug("realmid: response 204", { path: opts.path });
      return undefined as T;
    }

    const text = await resp.text();
    let body: unknown;
    if (text.length === 0) {
      body = undefined;
    } else {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!resp.ok) {
      const err = mapErrorResponse(resp.status, body, opts.method ?? "GET", opts.path);
      this.logger.error("realmid: request failed", {
        method: init.method,
        path: opts.path,
        status: resp.status,
        code: err.code,
      });
      throw err;
    }
    this.logger.debug("realmid: response ok", {
      method: init.method,
      path: opts.path,
      status: resp.status,
    });
    return body as T;
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    let url = this.baseUrl + (path.startsWith("/") ? path : `/${path}`);
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") {
          params.set(k, String(v));
        }
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    return url;
  }
}

function mapErrorResponse(status: number, body: unknown, method: string, path: string): RealmError {
  let code: ErrorCode = statusToCode(status);
  let message = `${method} ${path} failed with HTTP ${status}`;
  let details: Record<string, unknown> | undefined;

  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const env = obj["error"];
    if (env && typeof env === "object") {
      const envObj = env as Record<string, unknown>;
      const serverCode = envObj["code"];
      if (typeof serverCode === "string" && isKnownCode(serverCode)) code = serverCode;
      const serverMsg = envObj["message"];
      if (typeof serverMsg === "string" && serverMsg.length > 0) {
        message = serverMsg;
      }
      // Siblings of `error` on the envelope (e.g. mfa_challenge_token).
      const siblings: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k !== "error") siblings[k] = v;
      }
      if (Object.keys(siblings).length > 0) details = siblings;
    } else if (typeof obj["code"] === "string" && isKnownCode(obj["code"] as string)) {
      // flat envelope { code, message, ... }
      code = obj["code"] as ErrorCode;
      if (typeof obj["message"] === "string") message = obj["message"];
      const siblings: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k !== "code" && k !== "message") siblings[k] = v;
      }
      if (Object.keys(siblings).length > 0) details = siblings;
    }
  }

  return new RealmError({ code, message, httpStatus: status, details });
}
