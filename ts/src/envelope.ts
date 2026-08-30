/**
 * The GoFr wire envelope — the one seam every RealmID client crosses, and the
 * one that has been re-implemented in four TypeScript files.
 *
 * The issuer and the reference BFF are GoFr services, so:
 *
 *  - a SUCCESSFUL body arrives wrapped as `{"data": …}` (and a POST answers
 *    **201**, not 200);
 *  - a FAILURE arrives in one of THREE shapes, not one:
 *      1. coded, nested      `{"error": {"code": "...", "message": "..."}}`,
 *         optionally with siblings beside `error` (`mfa_challenge_token`,
 *         `revocation_token`) that carry the payload a gate needs;
 *      2. flat               `{"error": "message", "code": "..."}`;
 *      3. CODE-LESS          `{"error": "Unauthenticated"}` — GoFr's own
 *         middleware rejecting a bad `Authorization` bearer before any handler
 *         runs. There is no `code` to branch on, ever.
 *
 * Shape 3 is why this module exists as a shared primitive rather than a helper
 * each caller writes: a retry guard keyed on a code silently never fires on the
 * framework 401, which is exactly the class of bug the two rejection paths have
 * produced repeatedly (see the issuer error-envelope note in the runbook).
 *
 * These functions are PURE and transport-free on purpose. They take a parsed
 * body, not a `Response`, so a partner can use them from `fetch`, from an
 * Express proxy, or from a test fixture.
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
   * emits codes the SDK's `ErrorCode` union does not (yet) name, and
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
    // Legacy nested form `{"error":{"code":…,"error":"<msg>"}}`: some refusals
    // carry no `message` key at all, and the nested object's own keys are never
    // collected into `details` either — so reading only `message` LOST the text
    // and the caller saw the bare `HTTP 403` fallback. The flat branch below has
    // always done this; the asymmetry was the defect.
    if ((message === undefined || message.length === 0) && typeof envObj["error"] === "string") {
      message = envObj["error"] as string;
    }
    // Gate payloads are nested INSIDE the error object, not beside it: GoFr
    // merges every key the issuer's `Response()` map adds into ONE object and
    // renders it under `error`, so `mfa_challenge_token`, `revocation_token`
    // and `active_sessions` all arrive in there. Collecting only the TOP-level
    // siblings handed a caller an empty details map and a step-up prompt with
    // no token to answer it. The BFF's own `writeStepUpChallenge` puts the
    // challenge BESIDE `error`, so both levels are read and a client that
    // handles one envelope handles the other. Nested wins a name collision,
    // matching sdk/go's collection order.
    details = merge(
      siblings(obj, (k) => k === "error"),
      siblings(envObj, (k) => k === "code" || k === "message" || k === "error"),
    );
  } else if (typeof env === "string") {
    // Shapes 2 and 3: flat, with or without a code beside it.
    message = env;
    if (typeof obj["code"] === "string") code = obj["code"];
    details = siblings(obj, (k) => k === "code" || k === "message" || k === "error");
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

/**
 * Combine two sibling sweeps, later argument winning a name collision. Returns
 * `undefined` when nothing was collected, so `details` stays absent rather than
 * becoming an empty object a caller has to distinguish from a populated one.
 */
function merge(
  ...parts: (Record<string, unknown> | undefined)[]
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const p of parts) {
    if (p) Object.assign(out, p);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
