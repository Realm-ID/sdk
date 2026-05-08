export type ErrorCode =
  | "network_error"
  | "unauthorized"
  | "forbidden"
  | "session_expired"
  | "session_replaced"
  | "mfa_required"
  | "mfa_failed"
  | "tenant_not_found"
  | "bad_request"
  | "server_error"
  | "unknown";

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
    if (/expired/i.test(msg)) return "session_expired";
    return "unauthorized";
  }
  if (status === 403) return "forbidden";
  if (status === 404) return "tenant_not_found";
  if (status >= 400 && status < 500) return "bad_request";
  if (status >= 500) return "server_error";
  return "unknown";
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
