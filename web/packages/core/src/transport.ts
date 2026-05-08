import { RealmError, classifyHttpStatus, extractMessage, pluckPath, DEFAULT_CODE_PATHS } from "./errors.js";
import type { CSRFConfig, Endpoints, GateCode, GateRule, RealmConfig } from "./types.js";
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
  /** When set, do not throw on these matching gate rules — return them as a typed RealmError to the caller. */
  gates?: GateRule[];
  /** Default true. POST/PUT/PATCH/DELETE inject the CSRF header (if configured). */
  applyCsrf?: boolean;
}

export interface TransportResponse<T> {
  status: number;
  body: T;
  headers: Headers;
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export class Transport {
  readonly baseUrl: string;
  readonly endpoints: Endpoints;
  readonly fetchImpl: typeof fetch;
  readonly csrf?: CSRFConfig;

  constructor(cfg: RealmConfig) {
    if (!cfg.baseUrl) throw new Error("RealmConfig.baseUrl is required");
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.endpoints = { ...DEFAULT_ENDPOINTS, ...(cfg.endpoints ?? {}) };
    this.fetchImpl = cfg.fetch ?? globalThis.fetch.bind(globalThis);
    this.csrf = cfg.csrf;
  }

  resolve(path: string): string {
    if (/^https?:\/\//.test(path)) return path;
    return this.baseUrl + (path.startsWith("/") ? path : "/" + path);
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: TransportOptions = {},
  ): Promise<TransportResponse<T>> {
    const url = this.resolve(path);
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(opts.headers ?? {}),
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.accessToken) headers["Authorization"] = `Bearer ${opts.accessToken}`;
    if (opts.tenantId) headers["X-Tenant-Id"] = opts.tenantId;

    if ((opts.applyCsrf ?? true) && this.csrf && UNSAFE_METHODS.has(method.toUpperCase())) {
      const tok = await resolveCsrf(this.csrf);
      if (tok) headers[this.csrf.headerName] = tok;
    }

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

    // Gate match: status+code → typed error before generic classification.
    const gate = matchGate(res.status, parsed, opts.gates);
    if (gate) {
      const payload = gate.rule.extract ? gate.rule.extract(parsed) : {};
      const msg = extractMessage(parsed) || `${method} ${path} → gate ${gate.rule.gate}`;
      throw new RealmError(gate.rule.gate, msg, res.status, { ...(payload ?? {}), raw: parsed });
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

function matchGate(
  status: number,
  body: unknown,
  rules: GateRule[] | undefined,
): { rule: GateRule } | null {
  if (!rules || rules.length === 0) return null;
  for (const rule of rules) {
    if (rule.status !== status) continue;
    if (rule.code !== undefined) {
      const want = Array.isArray(rule.code) ? rule.code : [rule.code];
      const codes = rule.codePath ? [pluckPath(body, rule.codePath)] : DEFAULT_CODE_PATHS.map((p) => pluckPath(body, p));
      const found = codes.find((c): c is string => typeof c === "string");
      if (!found || !want.includes(found)) continue;
    }
    return { rule };
  }
  return null;
}

async function resolveCsrf(cfg: CSRFConfig): Promise<string | undefined> {
  if (cfg.tokenProvider) return cfg.tokenProvider();
  if (cfg.cookieName && typeof document !== "undefined") {
    const target = `${cfg.cookieName}=`;
    for (const part of (document.cookie || "").split(";")) {
      const trimmed = part.trim();
      if (trimmed.startsWith(target)) return decodeURIComponent(trimmed.slice(target.length));
    }
  }
  return undefined;
}

export type { GateCode };
