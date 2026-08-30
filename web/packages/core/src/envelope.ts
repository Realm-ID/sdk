/**
 * The GoFr wire envelope — success unwrap + the three error shapes.
 *
 * ⚠️ **`@realm-id/sdk` OWNS this contract.** `sdk/ts/src/envelope.ts` is the
 * canonical implementation; this file exists only because `@realm-id/web` ships
 * with **zero runtime dependencies** and therefore cannot import it. The two
 * are held identical by `envelope.test.ts`'s PARITY tests, which run both
 * implementations over the same fixture table and fail on any divergence. If
 * you change anything here, change it there first.
 *
 * Recap of what the seam actually looks like, because getting it wrong is a
 * recurring bug source rather than a theoretical risk:
 *
 *  - a SUCCESSFUL body arrives wrapped as `{"data": …}` (and a POST answers
 *    **201**, not 200);
 *  - a FAILURE arrives in one of THREE shapes:
 *      1. coded, nested   `{"error": {"code", "message"}}`, optionally with
 *         siblings beside `error` (`mfa_challenge_token`, `revocation_token`)
 *         carrying the payload a gate needs;
 *      2. flat            `{"error": "message", "code": "..."}`;
 *      3. CODE-LESS       `{"error": "Unauthenticated"}` — GoFr's own
 *         middleware rejecting a bad bearer before any handler runs. There is
 *         no `code` to branch on, ever, which is why a retry guard keyed on a
 *         code silently never fires on the framework 401.
 *
 * NOT the same function as `unwrapEnvelope` in `transport.ts`: that one only
 * unwraps when `data` is the SOLE key. Both rules are deliberate; do not
 * collapse them.
 */

/**
 * Strip a single `{ data: T }` envelope, if present.
 *
 * Exactly ONE level, and only when `data` holds something. A body whose own
 * payload has a `data` key set to `undefined` is returned untouched — treating
 * that as an empty envelope would silently drop a real field. Reads the top
 * level when there is no `data` key at all, so it keeps working if the envelope
 * ever goes away.
 */
export function unwrapData<T>(raw: unknown): T {
  if (raw && typeof raw === "object" && "data" in (raw as Record<string, unknown>)) {
    const d = (raw as { data?: unknown }).data;
    if (d !== undefined) return d as T;
  }
  return raw as T;
}

/** The parts an error envelope carries, before any mapping into `ErrorCode`. */
export interface ErrorEnvelope {
  /**
   * The code the SERVER sent, verbatim and unmapped — `undefined` for the
   * code-less framework rejection. Deliberately a plain `string`: the issuer
   * emits codes this SDK's `ErrorCode` union does not (yet) name, and
   * discarding one here is how a specific remedy becomes a generic 403.
   */
  code?: string;
  /** The server's message, or `HTTP <status>` when it sent none. */
  message: string;
  /** Envelope siblings — gate payloads such as `mfa_challenge_token`. */
  details?: Record<string, unknown>;
}

/**
 * Parse a non-2xx body into its `{code, message, details}` parts.
 *
 * Never throws and never guesses: an unrecognisable body yields just the
 * status-shaped message, so a proxy or an HTML error page degrades to a
 * truthful "HTTP 502" instead of a fabricated code.
 */
export function parseErrorEnvelope(body: unknown, status: number): ErrorEnvelope {
  const fallback = `HTTP ${status}`;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { message: fallback };
  }

  const obj = body as Record<string, unknown>;
  const env = obj["error"];
  let code: string | undefined;
  let message: string | undefined;
  let details: Record<string, unknown> | undefined;

  if (env && typeof env === "object" && !Array.isArray(env)) {
    // Shape 1: coded, nested. Siblings of `error` are the gate payload.
    const envObj = env as Record<string, unknown>;
    if (typeof envObj["code"] === "string") code = envObj["code"];
    if (typeof envObj["message"] === "string") message = envObj["message"];
    details = siblings(obj, (k) => k === "error");
  } else if (typeof env === "string") {
    // Shapes 2 and 3: flat, with or without a code beside it.
    message = env;
    if (typeof obj["code"] === "string") code = obj["code"];
  } else if (typeof obj["code"] === "string") {
    // Top-level `{code, message, ...siblings}`.
    code = obj["code"];
    if (typeof obj["message"] === "string") message = obj["message"];
    details = siblings(obj, (k) => k === "code" || k === "message");
  }

  const out: ErrorEnvelope = {
    message: message && message.length > 0 ? message : fallback,
  };
  if (code !== undefined && code.length > 0) out.code = code;
  if (details) out.details = details;
  return out;
}

function siblings(
  obj: Record<string, unknown>,
  isEnvelopeKey: (k: string) => boolean,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!isEnvelopeKey(k)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
