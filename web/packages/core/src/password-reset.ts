/**
 * The password-reset page's two calls (ADR-111, SPEC §4.10).
 *
 * Both routes are ANONYMOUS at the BFF — the token in the body IS the
 * credential — so this does not go through the realm's authenticated `fetch`
 * (there is no session on a reset page, and `bffCall` would try to attach one).
 *
 * The token and the new password are secrets: never logged here, the token is
 * never put in a URL, and both requests send `referrerPolicy: "no-referrer"`
 * and no cookies. Parsing the token out of `location.hash` is the PAGE's job.
 *
 * Neither call retries. A consume replayed after a lost response answers
 * `reset_token_used` even though the password WAS set (SPEC §4.10).
 */

import { RealmError, classifyHttpStatus } from "./errors.js";
import { unwrapData, parseErrorEnvelope } from "./envelope.js";
import { joinBase } from "./bff-call.js";

/**
 * The codes a reset page branches on (SPEC §3.1). The first four are the link
 * states; the last three are `consume` input refusals. Held in step with the
 * spec by a test that reads SPEC.md.
 */
export type PasswordResetCode =
  | "reset_token_invalid"
  | "reset_token_expired"
  | "reset_token_used"
  | "reset_token_superseded"
  | "password_too_short"
  | "password_too_long"
  | "password_unchanged";

export const PASSWORD_RESET_CODES: readonly PasswordResetCode[] = [
  "reset_token_invalid",
  "reset_token_expired",
  "reset_token_used",
  "reset_token_superseded",
  "password_too_short",
  "password_too_long",
  "password_unchanged",
];

const CODE_SET: ReadonlySet<string> = new Set<string>(PASSWORD_RESET_CODES);

/**
 * The reset code in a thrown value, or `null` for anything else. Reads
 * `.body.code` (this package), `.details.server_code` and `.code`
 * (`@realm-id/sdk`-shaped errors), so a page holding either client works.
 */
export function passwordResetCode(err: unknown): PasswordResetCode | null {
  if (!err || typeof err !== "object") return null;
  const e = err as Record<string, unknown>;
  const out: unknown[] = [e["code"]];
  const details = e["details"] as Record<string, unknown> | undefined;
  if (details && typeof details === "object") out.push(details["server_code"], details["code"]);
  const body = e["body"] as Record<string, unknown> | undefined;
  if (body && typeof body === "object") {
    out.push(body["code"], body["server_code"]);
    const raw = body["raw"] as Record<string, unknown> | undefined;
    if (raw && typeof raw === "object") {
      out.push(raw["code"]);
      const env = raw["error"] as Record<string, unknown> | undefined;
      if (env && typeof env === "object") out.push(env["code"]);
    }
  }
  for (const c of out) if (typeof c === "string" && CODE_SET.has(c)) return c as PasswordResetCode;
  return null;
}

export interface PasswordResetInspection {
  /** When the link stops working (ISO-8601 string, as the issuer sent it). */
  expiresAt: string;
}

export interface PasswordResetOptions {
  /** Absolute base URL of the BFF. */
  baseUrl: string;
  /** Override the transport (tests, SSR). Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

export interface PasswordReset {
  /**
   * Is this link still usable? Writes nothing and does NOT consume it; a `200`
   * is not a reservation. Throws `reset_token_invalid` (400) or
   * `reset_token_expired` / `reset_token_used` / `reset_token_superseded` (410).
   */
  inspectPasswordReset(token: string): Promise<PasswordResetInspection>;
  /**
   * Set the password. Mints NO session — send the holder to sign in. Throws the
   * four link codes above plus `password_too_short` / `password_too_long` (400).
   * NEVER retried.
   */
  consumePasswordReset(token: string, newPassword: string): Promise<void>;
}

export function createPasswordReset(opts: PasswordResetOptions): PasswordReset {
  const post = async (path: string, payload: Record<string, string>): Promise<unknown> => {
    const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    let res: Response;
    try {
      res = await doFetch(joinBase(opts.baseUrl, path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch (e) {
      throw new RealmError("network_error", (e as Error)?.message ?? "fetch failed");
    }
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
    return parsed;
  };

  return {
    async inspectPasswordReset(token) {
      const body = unwrapData<{ expires_at?: string }>(await post("/auth/password/reset/inspect", { token }));
      return { expiresAt: body?.expires_at ?? "" };
    },
    async consumePasswordReset(token, newPassword) {
      await post("/auth/password/reset", { token, new_password: newPassword });
    },
  };
}
