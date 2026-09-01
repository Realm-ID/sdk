/**
 * scopes-handler.ts — ADR-097 granted authority, resolved per mint.
 *
 * This is the `scope` twin of {@link ProductRolesHandler}, and the two are
 * deliberately shaped identically: one realm-level handler, run at every mint,
 * its result carried onto the token. They answer different questions — `scope`
 * is GRANTED AUTHORITY and `product_roles` is a NAME — but they are resolved by
 * the same mechanism because they have the same freshness requirement.
 *
 * ## Why a handler at all, rather than a field on the request
 *
 * A per-call field only reaches calls a partner writes BY HAND. In a BFF
 * deployment humans mint through the middleware, which builds the request
 * itself and never exposes it — so a per-call field is, for the lane that
 * carries every human session, unreachable. That is not hypothetical: a partner
 * hit it, and the integration guide had to be corrected for pointing at
 * `TokenRequest.scope` instead of the realm-level handler.
 *
 * ⚠️ Not to be confused with `scopes.ts` ({@link ScopesClient}), which is the
 * ADR-097 §F realm-wide bulk RENAME of scope strings, or with `scope.ts`, which
 * is the enforcement layer that READS the minted claim.
 */

/**
 * Resolves the partner's own ADR-097 scope strings for a principal in one org.
 *
 * ⚠️ **SIDE-EFFECT FREEDOM IS A CONTRACT, NOT A SUGGESTION.** The SDK calls this
 * an UNSPECIFIED NUMBER OF TIMES per mint — it retries on error — so the handler
 * MUST NOT write, bill, audit, or emit. A partner who logs "scopes resolved"
 * inside it will see triple entries and be right to call it a bug. Retrying is
 * only legal because this is specified as a pure read.
 *
 * It runs on EVERY mint, refresh included, and nothing caches. That is the whole
 * point: the issuer NEVER stores `scope` on a session — deliberately, so it
 * cannot go stale — so an unrequested claim is an ABSENT one, and absent reads
 * as "no granted authority" in every SDK gate. A session whose scopes are
 * resolved only at login therefore loses its authority at the first refresh.
 *
 * Returning an empty array mints NO claim, not `[]`. Absent and empty must mean
 * the same thing here: every token issued before ADR-097 has no claim at all, so
 * a reader handles absence regardless.
 *
 * ⚠️ That rule is NOT shared with `rolePermissions`, where an empty non-nil list
 * is a real instruction ("this role confers nothing here") that the issuer
 * answers with a `403`. The asymmetry is deliberate; do not harmonise it.
 */
export type ScopesHandler = (
  tenantId: string,
  userId: string,
  signal?: AbortSignal,
) => Promise<string[]> | string[];

/**
 * Reports that YOUR handler failed and the SDK therefore refused to mint.
 *
 * ⚠️ Deliberately NOT a `RealmError`, for the reason {@link ProductRolesError}
 * gives: "your scope handler failed 3 times" and "RealmID refused your mint" are
 * different incidents and must not look alike in your logs — one is your
 * database, the other is ours.
 *
 * The refusal is the point, and it matters more here than it does for
 * `product_roles`. Minting anyway would put NO granted authority on the token,
 * which every gate reads as "denied" — so a transient blip in your role store
 * would become an authorization outage that our logs record as a clean 200.
 */
export class ScopesError extends Error {
  readonly tenantId: string;
  readonly userId: string;
  readonly attempts: number;
  readonly cause?: unknown;

  constructor(tenantId: string, userId: string, attempts: number, cause?: unknown) {
    super(`scopes handler failed after ${attempts} attempts for tenant ${tenantId}: ${String(cause)}`);
    this.name = "ScopesError";
    this.tenantId = tenantId;
    this.userId = userId;
    this.attempts = attempts;
    this.cause = cause;
  }
}

/**
 * The retry budget, SHARED with `product_roles` on purpose.
 *
 * Two retry budgets on one mint path would compound into a latency ceiling
 * nobody chose: the two handlers run in sequence, so the worst case is the sum,
 * and keeping them identical is what makes that sum predictable. The constants
 * are re-exported from `product-roles.ts` rather than re-declared, so the two
 * cannot drift apart silently.
 */
export { PRODUCT_ROLES_ATTEMPTS as SCOPES_ATTEMPTS, PRODUCT_ROLES_BACKOFF_MS as SCOPES_BACKOFF_MS } from "./product-roles.js";

import { PRODUCT_ROLES_ATTEMPTS, PRODUCT_ROLES_BACKOFF_MS } from "./product-roles.js";

/**
 * Runs a handler with the shared retry policy.
 *
 * Returns `undefined` when no handler is configured — the claim is omitted and
 * that is NOT an error. Making it mandatory would break every existing
 * integration on upgrade for a feature they did not ask for.
 *
 * EVERY error is retried and there is no taxonomy: the SDK cannot tell your
 * transient store error from a permanent one.
 */
export async function resolveScopes(
  handler: ScopesHandler | undefined,
  tenantId: string,
  userId: string,
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  if (!handler) return undefined;
  let last: unknown;
  for (let attempt = 0; attempt < PRODUCT_ROLES_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // ABORT IMMEDIATELY if the caller has given up. A retry loop that
      // outlives its caller turns a client timeout into a server-side pileup.
      if (signal?.aborted) throw new ScopesError(tenantId, userId, attempt, last);
      await sleep(PRODUCT_ROLES_BACKOFF_MS[attempt - 1]!, signal);
    }
    try {
      return await handler(tenantId, userId, signal);
    } catch (err) {
      last = err;
      if (signal?.aborted) break;
    }
  }
  throw new ScopesError(tenantId, userId, PRODUCT_ROLES_ATTEMPTS, last);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
