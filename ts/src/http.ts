/**
 * Internal HTTP client. Wraps fetch and translates non-2xx responses + network
 * failures into RealmError. Server error envelopes are expected in the shape:
 *   { error: { code, message }, ...siblings }
 * where siblings (e.g. mfa_challenge_token) flow into RealmError.details.
 */

import { RealmError, statusToCode, isKnownCode, type ErrorCode } from "./errors.js";

export interface HttpClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  apiKey?: string;
  /** Default authorization for every request unless overridden in opts.headers. */
  defaultAuth?: () => string | undefined;
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
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly apiKey?: string;

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.apiKey = opts.apiKey;
  }

  async request<T = unknown>(opts: RequestOptions): Promise<T> {
    const url = this.buildUrl(opts.path, opts.query);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "accept": "application/json",
    };
    const bearer = opts.bearer ?? this.apiKey;
    if (bearer) headers["authorization"] = `Bearer ${bearer}`;
    if (opts.headers) Object.assign(headers, opts.headers);

    const init: RequestInit = {
      method: opts.method ?? "GET",
      headers,
    };
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
    }

    let resp: Response;
    try {
      resp = await this.fetch(url, init);
    } catch (e) {
      throw new RealmError({
        code: "network",
        message: `network error calling ${opts.method ?? "GET"} ${opts.path}: ${(e as Error).message}`,
        cause: e,
      });
    }

    if (resp.status === 204) {
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
      throw mapErrorResponse(resp.status, body, opts.method ?? "GET", opts.path);
    }
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
