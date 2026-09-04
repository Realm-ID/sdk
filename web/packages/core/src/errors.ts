export type ErrorCode =
  | "network_error"
  | "unauthorized"
  | "forbidden"
  | "session_expired"
  | "session_replaced"
  | "session_revoked"
  // ADR-107 D10 — the access token was minted before the subject's authority
  // changed. NOT a session failure: the remedy is one refresh, and the session
  // continues (D11 is explicit that demotion does not evict it).
  //
  // It has to be its own code precisely because it arrives as a 401. Collapsed
  // into `unauthorized` it would be swept into the sign-out branch, and the
  // user would be signed out on PROMOTION — on a grant that just widened their
  // access.
  | "token_stale"
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
    // The ONE wire code this classifier reads from the body rather than
    // inferring from the message. It is deliberately not a general "trust the
    // body's code" rule: the classifier's contract is a CLASSIFICATION, and
    // `.body.code` stays the fact. But `token_stale` cannot be inferred — it is
    // a plain 401 whose message is prose — and misreading it as `unauthorized`
    // signs the user out on promotion (ADR-107 D10).
    for (const path of DEFAULT_CODE_PATHS) {
      if (pluckPath(body, path) === "token_stale") return "token_stale";
    }
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
