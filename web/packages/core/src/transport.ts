import { RealmError, classifyHttpStatus } from "./errors.js";
import type { Endpoints, RealmConfig } from "./types.js";
import { DEFAULT_ENDPOINTS } from "./types.js";

export interface TransportOptions {
  body?: unknown;
  accessToken?: string;
  tenantId?: string;
  signal?: AbortSignal;
  /** Send credentials so the BFF cookie travels. Default "include". */
  credentials?: RequestCredentials;
  /** Extra headers passthrough. */
  headers?: Record<string, string>;
}

export class Transport {
  readonly baseUrl: string;
  readonly endpoints: Endpoints;
  readonly fetchImpl: typeof fetch;

  constructor(cfg: RealmConfig) {
    if (!cfg.baseUrl) throw new Error("RealmConfig.baseUrl is required");
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.endpoints = { ...DEFAULT_ENDPOINTS, ...(cfg.endpoints ?? {}) };
    this.fetchImpl = cfg.fetch ?? globalThis.fetch.bind(globalThis);
  }

  resolve(path: string): string {
    if (/^https?:\/\//.test(path)) return path;
    return this.baseUrl + (path.startsWith("/") ? path : "/" + path);
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: TransportOptions = {},
  ): Promise<{ status: number; body: T; headers: Headers }> {
    const url = this.resolve(path);
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(opts.headers ?? {}),
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.accessToken) headers["Authorization"] = `Bearer ${opts.accessToken}`;
    if (opts.tenantId) headers["X-Tenant-Id"] = opts.tenantId;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        credentials: opts.credentials ?? "include",
        signal: opts.signal,
      });
    } catch (err) {
      throw new RealmError("network_error", (err as Error)?.message ?? "fetch failed");
    }

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const code = classifyHttpStatus(res.status, parsed);
      const msg = extractMessage(parsed) || `${method} ${path} → ${res.status}`;
      throw new RealmError(code, msg, res.status, parsed);
    }
    return { status: res.status, body: unwrapEnvelope(parsed) as T, headers: res.headers };
  }
}

/**
 * Many GoFr-shaped backends wrap success bodies as `{ data: ... }`. Unwrap
 * once if present so the SDK callers see a flat shape. Idempotent on
 * unwrapped bodies.
 */
export function unwrapEnvelope(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  if ("data" in b && Object.keys(b).length === 1) return b.data;
  return body;
}

function extractMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as Record<string, unknown>;
  if (typeof b.message === "string") return b.message;
  const err = b.error;
  if (err && typeof err === "object" && typeof (err as Record<string, unknown>).message === "string") {
    return (err as Record<string, string>).message;
  }
  return "";
}
