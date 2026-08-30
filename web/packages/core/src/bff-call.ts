/**
 * Internal: one JSON call against a TYPED BFF route, through the realm's own
 * authenticated `fetch`.
 *
 * Not exported from the package index — it is the shared body of
 * `memberships.ts` and `revocation-sessions.ts`, both of which talk to routes
 * the BFF registers itself (as opposed to the `/api/*` passthrough that
 * `@realm-id/web-admin` uses for issuer routes).
 *
 * It throws `RealmError` with the SERVER's code preserved on `.body`. The
 * `ErrorCode` union is closed and deliberately does not name every issuer code,
 * so the mapped `.code` is a classification and `.body.code` is the fact.
 * Discarding the latter is how `owner_cannot_leave` and `already_left` become
 * one indistinguishable banner.
 */

import { RealmError, classifyHttpStatus } from "./errors.js";
import { unwrapData, parseErrorEnvelope } from "./envelope.js";

/** The slice of `Realm` these clients need. Structural so a test can stand in. */
export interface RealmFetchLike {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export interface BffCallOptions {
  method: "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
  path: string;
  body?: unknown;
  /**
   * An explicit one-shot credential (the session-limit `revocation_token`).
   * Setting it also marks the call ANONYMOUS, because these run before a
   * session exists and the SDK must not try to attach one.
   */
  bearer?: string;
}

export function joinBase(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`);
}

export async function bffCall<T>(
  realm: RealmFetchLike,
  baseUrl: string,
  opts: BffCallOptions,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.bearer) headers["Authorization"] = `Bearer ${opts.bearer}`;

  const init: RequestInit & { anonymous?: boolean } = {
    method: opts.method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  };
  if (opts.bearer) init.anonymous = true;

  let res: Response;
  try {
    res = await realm.fetch(joinBase(baseUrl, opts.path), init);
  } catch (e) {
    // A typed error the SDK raised before the request left the browser (a dead
    // session, say) is an auth state, not a transport failure — re-throw it so
    // the caller can branch on the real code. Only a bare rejection is network.
    if (typeof (e as { code?: unknown } | null)?.code === "string") throw e;
    throw new RealmError("network_error", (e as Error)?.message ?? "fetch failed");
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }

  if (!res.ok) {
    const env = parseErrorEnvelope(parsed, res.status);
    throw new RealmError(classifyHttpStatus(res.status, parsed), env.message, res.status, {
      code: env.code,
      message: env.message,
      details: env.details,
      raw: parsed,
    });
  }

  return unwrapData<T>(parsed);
}
