/**
 * The typed error of R86 (SPEC §14.10): ONE class for the server's `403 actor_required` and for the
 * SDK's local refusal of a bare-platform call on an actor route (R61). The HTTP decoder builds it
 * from the server's code; `HttpClient` builds it, sending nothing, when a call that needs an actor
 * carries none. It is the first code mapped to a subclass (SPEC §3.1 otherwise forbids one).
 */

import { RealmError } from "./errors.js";

/** The text partners read when a job forgets the actor (SPEC §14.10). */
export const ACTOR_REQUIRED_HINT = "This action needs a user or service account. Send its token in X-User-Token.";

export class ActorRequiredError extends RealmError {
  constructor(opts?: { message?: string; httpStatus?: number; cause?: unknown; details?: Record<string, unknown> }) {
    const m = opts?.message?.trim() ?? "";
    // The server's wording is kept and the hint appended, unless the server already names the header.
    const message = m === "" ? ACTOR_REQUIRED_HINT : m.includes("X-User-Token") ? m : `${m} ${ACTOR_REQUIRED_HINT}`;
    super({ code: "actor_required", message, httpStatus: opts?.httpStatus, cause: opts?.cause, details: opts?.details });
    this.name = "ActorRequiredError";
  }
}

/** True when `err` is, or wraps (via `cause`), an {@link ActorRequiredError}. Safe on anything. */
export function isActorRequired(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 16 && e !== undefined && e !== null; i++) {
    if (e instanceof ActorRequiredError) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
