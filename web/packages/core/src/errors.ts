export type ErrorCode =
  | "network_error"
  | "unauthorized"
  | "forbidden"
  | "session_expired"
  | "session_replaced"
  | "session_revoked"
  | "mfa_required"
  | "mfa_registration_required"
  | "mfa_failed"
  | "session_limit_reached"
  | "tenants_required"
  | "tenant_not_found"
  | "no_pending_login"
  | "bad_request"
  | "server_error"
  | "unsupported_provider"
  | "provider_not_configured"
  | "oidc_state_mismatch"
  | "no_browser"
  | "unknown";

/**
 * Single error type used across the SDK. `code` is the canonical reason
 * partners switch on; `body` carries gate-specific payloads (mfa
 * challengeToken, session-limit revocationToken, tenants_required picker).
 */
export class RealmError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly body: unknown;

  constructor(code: ErrorCode, message: string, status = 0, body: unknown = undefined) {
    super(message);
    this.name = "RealmError";
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

export function classifyHttpStatus(status: number, body?: unknown): ErrorCode {
  if (status === 401) {
    const msg = extractMessage(body);
    if (/replaced|invalidated/i.test(msg)) return "session_replaced";
    if (/revoked/i.test(msg)) return "session_revoked";
    if (/expired/i.test(msg)) return "session_expired";
    return "unauthorized";
  }
  if (status === 403) return "forbidden";
  if (status === 404) return "tenant_not_found";
  if (status >= 400 && status < 500) return "bad_request";
  if (status >= 500) return "server_error";
  return "unknown";
}

export function extractMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as Record<string, unknown>;
  if (typeof b.message === "string") return b.message;
  const err = b.error;
  if (err && typeof err === "object" && typeof (err as Record<string, unknown>).message === "string") {
    return (err as Record<string, string>).message;
  }
  return "";
}

/** Read a dotted/array path out of a parsed body. Returns undefined if any segment is missing. */
export function pluckPath(body: unknown, path: string[] | undefined): unknown {
  if (!path || path.length === 0) return undefined;
  let cur: unknown = body;
  for (const seg of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Default body locations the SDK probes for a `code` field, in order. */
export const DEFAULT_CODE_PATHS: string[][] = [["code"], ["error", "code"]];
