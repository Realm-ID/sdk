/**
 * Transport shim: adapts a `@realm-id/web` Realm's authenticated `fetch`
 * into an object that quacks like `@realm-id/sdk/internal`'s `HttpClient`.
 *
 * Resource classes from `@realm-id/sdk` only call `request<T>(opts)`, so
 * a single-method shim is enough. The shim:
 *
 *   - prefixes paths with `/api` (default) so requests route through the
 *     BFF's passthrough to `auth.realmid.dev`; only paths the BFF actually
 *     registers as *typed* routes (`/home`, `/tenants/{id}/full`, `/me`,
 *     `/identity-providers`, `/sessions` — the pre-login revocation-token
 *     flow, plus anything the caller opts in via the `x-realmid-via: bff`
 *     header) hit the BFF directly. NOTE: `/admin/...` and the authed
 *     `/auth/sessions` surface are **issuer** routes, NOT BFF typed routes
 *     — they MUST go through the `/api` passthrough (the BFF registers
 *     neither; treating them as BFF-direct 404s). See
 *     `api/cmd/bff/main.go` for the authoritative BFF route list and
 *     `issuer/internal/httpapi/routes.go` for the `/admin/*` +
 *     `/auth/sessions` surface reached via passthrough.
 *   - delegates the actual `fetch` to `realm.fetch`, so the SDK's
 *     Authorization-attach, refresh-on-401, and multi-tab logout sync
 *     still apply.
 *   - parses the GoFr `{ data: T }` success envelope (unwrapping once)
 *     and the dual-form error envelope (`{ error: { code, message } }`
 *     OR root-level `code`/`error`) — see `parseApiError` in
 *     `ui/web/src/api.ts` for the prior art.
 *   - throws `RealmError` from `@realm-id/sdk` so callers can `catch`
 *     uniformly with the resource clients' native error type.
 *
 * The `realm` (from `@realm-id/web`) doesn't expose `baseUrl()` on its
 * public surface, so the caller must pass it explicitly via `opts.baseUrl`.
 */

import type { Realm } from "@realm-id/web";
import { RealmError } from "@realm-id/sdk";
import type { ErrorCode } from "@realm-id/sdk";
import type { RequestOptions } from "@realm-id/sdk/internal";

/** Header marker (case-insensitive) used to override path routing:
 *   - `bff` → bypass the `/api` prefix and hit the BFF's typed routes.
 *   - `api` → force the `/api` passthrough even for a path that would
 *     otherwise be BFF-direct. Needed when an *issuer* route shares a
 *     path with a BFF-direct one — e.g. the admin `/identity-providers`
 *     CRUD (issuer, `requireRealmAdmin`) collides with the BFF's public
 *     `GET /identity-providers` lookup. The header is stripped before
 *     the request hits the wire (see the request builder below). */
const VIA_HEADER = "x-realmid-via";

/**
 * Path prefixes that hit BFF-direct (no `/api`). Must match EXACTLY the
 * typed routes registered in `api/cmd/bff/main.go`. Everything else —
 * including `/admin/*` and the authed `/auth/sessions` surface, which are
 * issuer routes — falls through to the `/api` passthrough.
 */
const BFF_DIRECT_PREFIXES: readonly string[] = [
  "/home",
  "/me",
  "/identity-providers",
  "/sessions",
];

/** Per-tenant-id helpers that hit BFF directly (`/tenants/{id}/full`). */
function isTenantFullPath(p: string): boolean {
  return /^\/tenants\/[^/]+\/full(\?.*)?$/.test(p);
}

function isBffDirect(path: string, headers?: Record<string, string>): boolean {
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === VIA_HEADER) {
        if (v === "bff") return true; // force BFF-direct
        if (v === "api") return false; // force /api passthrough (issuer route sharing a BFF-direct prefix)
      }
    }
  }
  for (const prefix of BFF_DIRECT_PREFIXES) {
    if (path === prefix || path.startsWith(prefix)) return true;
  }
  return isTenantFullPath(path);
}

/** Duck-typed slice of `HttpClient`. Resource classes only need this. */
export interface HttpLike {
  request<T = unknown>(opts: RequestOptions): Promise<T>;
}

export interface RealmFetchHttpOptions {
  /** Absolute base URL of the BFF (e.g. `https://api.realmid.dev`). */
  baseUrl: string;
  /** Prefix for passthrough paths. Default `/api`. */
  apiPrefix?: string;
}

export function realmFetchAsHttpClient(
  realm: Realm,
  opts: RealmFetchHttpOptions,
): HttpLike {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const apiPrefix = opts.apiPrefix ?? "/api";

  return {
    async request<T = unknown>(req: RequestOptions): Promise<T> {
      const direct = isBffDirect(req.path, req.headers);
      const prefix = direct ? "" : apiPrefix;
      const pathPart = req.path.startsWith("/") ? req.path : `/${req.path}`;
      let url = `${base}${prefix}${pathPart}`;

      if (req.query) {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(req.query)) {
          if (v === undefined || v === null || v === "") continue;
          params.set(k, String(v));
        }
        const qs = params.toString();
        if (qs) url += (url.includes("?") ? "&" : "?") + qs;
      }

      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (req.headers) {
        for (const [k, v] of Object.entries(req.headers)) {
          if (k.toLowerCase() === VIA_HEADER) continue;
          headers[k] = v;
        }
      }
      if (req.bearer) {
        headers["authorization"] = `Bearer ${req.bearer}`;
      }

      // When the caller supplies their own credential (`bearer`) or
      // explicitly opts out of the platform-token mint (the closest
      // equivalent here is "I'm bringing my own auth"), bypass the
      // SDK's session-bearer attach so the explicit bearer wins.
      const anonymous = !!req.bearer || req.skipPlatformToken === true;

      const init: RequestInit & { anonymous?: boolean } = {
        method: req.method ?? "GET",
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
      };
      if (anonymous) init.anonymous = true;

      let resp: Response;
      try {
        resp = await realm.fetch(url, init as RequestInit);
      } catch (e) {
        // `realm.fetch` throws a typed error for conditions it detects
        // client-side before any request leaves the browser — most notably
        // `unauthorized`/"no current tenant" when the session's current tenant
        // was cleared out from under an in-flight call (the long-idle reload
        // teardown race). Those are auth/session states, NOT transport
        // failures: re-throw them unchanged so callers can branch on the real
        // code (route to sign-in) instead of a misleading "network error"
        // retry. Only a genuine fetch failure (a TypeError with no `code`) is a
        // network error.
        //
        // NB: duck-type on `code` rather than `instanceof RealmError` — the
        // error thrown here is `@realm-id/web`'s RealmError (a DIFFERENT class
        // from this package's `@realm-id/sdk` RealmError), so `instanceof`
        // would miss it. Any thrown value carrying a string `code` is already
        // a typed realm error; a browser fetch rejection is a bare TypeError.
        if (typeof (e as { code?: unknown } | null)?.code === "string") throw e;
        throw new RealmError({
          code: "network",
          message: `network error calling ${init.method} ${req.path}: ${(e as Error).message}`,
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
        try { body = JSON.parse(text); } catch { body = text; }
      }

      if (!resp.ok) {
        throw mapErrorResponse(resp.status, body, init.method ?? "GET", req.path);
      }

      return unwrapData<T>(body);
    },
  };
}

/** Strip a single `{ data: T }` envelope, if present. */
function unwrapData<T>(raw: unknown): T {
  if (raw && typeof raw === "object" && "data" in (raw as Record<string, unknown>)) {
    const d = (raw as { data?: unknown }).data;
    if (d !== undefined) return d as T;
  }
  return raw as T;
}

function mapErrorResponse(status: number, body: unknown, method: string, path: string): RealmError {
  let code: ErrorCode = statusToCode(status);
  let serverCodeRaw: string | undefined;
  let message = `${method} ${path} failed with HTTP ${status}`;
  let details: Record<string, unknown> | undefined;

  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const env = obj["error"];
    if (env && typeof env === "object") {
      const envObj = env as Record<string, unknown>;
      const sc = envObj["code"];
      if (typeof sc === "string") serverCodeRaw = sc;
      const serverMsg = envObj["message"];
      if (typeof serverMsg === "string" && serverMsg.length > 0) message = serverMsg;
      const siblings: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k !== "error") siblings[k] = v;
      }
      if (Object.keys(siblings).length > 0) details = siblings;
    } else if (typeof env === "string") {
      // Flat: { error: "message", code?: "..." }
      message = env;
      if (typeof obj["code"] === "string") serverCodeRaw = obj["code"] as string;
    } else if (typeof obj["code"] === "string") {
      serverCodeRaw = obj["code"] as string;
      if (typeof obj["message"] === "string") message = obj["message"] as string;
      const siblings: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k !== "code" && k !== "message") siblings[k] = v;
      }
      if (Object.keys(siblings).length > 0) details = siblings;
    }
  }

  if (serverCodeRaw && isErrorCode(serverCodeRaw)) {
    code = serverCodeRaw;
  } else if (serverCodeRaw) {
    // Stash the original server code so callers can branch on it.
    details = { ...(details ?? {}), server_code: serverCodeRaw };
  }

  return new RealmError({ code, message, httpStatus: status, details });
}

const KNOWN_CODES = new Set<ErrorCode>([
  "malformed", "wrong_algorithm", "bad_signature", "wrong_issuer", "wrong_audience",
  "expired", "not_yet_valid", "unknown_kid", "jwks_fetch_failed",
  "provider_token_invalid", "mfa_required", "session_limit_reached",
  "tenant_required", "tenant_invalid", "account_suspended", "account_deactivated",
  "realm_origin_mismatch", "realm_mismatch", "missing_origin",
  "invalid_otp", "otp_expired", "otp_locked", "otp_not_found",
  "invalid_purpose", "invalid_subject_ref",
  "unauthorized", "forbidden", "not_found", "conflict", "rate_limited",
  "bad_request", "network", "server_error",
]);

function isErrorCode(s: string): s is ErrorCode {
  return KNOWN_CODES.has(s as ErrorCode);
}

function statusToCode(status: number): ErrorCode {
  if (status === 400) return "bad_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "server_error";
}
