/**
 * product-roles.ts — ADR-102 D3/D11: the PARTNER's role name on the token.
 *
 * `scope` (ADR-097) carries granted AUTHORITY; `product_roles` carries the NAME
 * of the role the bearer holds in YOUR system, for display ("Signed in as:
 * Dispatch"), routing, report defaults and your own audit trail.
 *
 * ⚠️ **Do NOT branch AUTHORIZATION on it.** A name is a label, a scope is a
 * grant. Keying authorization off the name re-creates exactly the coupling
 * ADR-101 spent four migrations removing. Both claims ride the same token and
 * answer different questions.
 */

/**
 * Resolves the partner's own role names for a principal in one org.
 *
 * ⚠️ **SIDE-EFFECT FREEDOM IS A CONTRACT, NOT A SUGGESTION.** The SDK calls this
 * an UNSPECIFIED NUMBER OF TIMES per mint — it retries on error (D11) — so the
 * handler MUST NOT write, bill, audit, or emit. A partner who logs "role
 * resolved" inside it will see triple entries and be right to call it a bug.
 * Retrying is only legal because this is specified as a pure read.
 *
 * It runs on EVERY mint, refresh included, and nothing caches. That freshness is
 * the entire advantage this claim has over `customClaims`, which snapshots a
 * value onto a long-lived session.
 *
 * Returning an empty array mints NO claim, not `[]`. Absent and empty must mean
 * the same thing: every token issued before ADR-102 has no claim at all, so a
 * reader has to handle absence regardless.
 */
export type ProductRolesHandler = (
  tenantId: string,
  userId: string,
  signal?: AbortSignal,
) => Promise<string[]> | string[];

/**
 * Reports that YOUR handler failed and the SDK therefore refused to mint
 * (ADR-102 D11 rule 3).
 *
 * ⚠️ Deliberately NOT a `RealmError`. "Your role handler failed 3 times" and
 * "RealmID refused your mint" are different incidents and must not look alike in
 * your logs — one is your database, the other is ours.
 *
 * The refusal is the point. Minting anyway would put "this principal has no
 * product roles" on the token, which is indistinguishable from the truth for a
 * principal who genuinely has none — a silent under-grant that surfaces as a
 * mysterious 403 storm in YOUR product, with a 200 in our logs.
 */
export class ProductRolesError extends Error {
  readonly tenantId: string;
  readonly userId: string;
  readonly attempts: number;
  readonly cause?: unknown;

  constructor(tenantId: string, userId: string, attempts: number, cause?: unknown) {
    super(
      `product_roles handler failed after ${attempts} attempts for tenant ${tenantId}: ${String(cause)}`,
    );
    this.name = "ProductRolesError";
    this.tenantId = tenantId;
    this.userId = userId;
    this.attempts = attempts;
    this.cause = cause;
  }
}

/**
 * The D11 retry policy.
 *
 * A role lookup is a DB read and a DB read fails transiently, so the refusal is
 * the LAST resort rather than the first response. Three attempts with ~50ms then
 * ~150ms of backoff puts a ceiling of roughly 200ms of added latency on the
 * login hot path with a human waiting — part of the decision, not an
 * implementation detail. Deliberately NOT exponential-unbounded.
 */
export const PRODUCT_ROLES_ATTEMPTS = 3;
export const PRODUCT_ROLES_BACKOFF_MS = [50, 150];

/**
 * Runs a handler with the D11 retry policy.
 *
 * Returns `undefined` when no handler is configured: the claim is omitted and
 * this is NOT an error. Making the handler mandatory would break every existing
 * integration on upgrade for a feature they did not ask for, on top of the
 * `login` behaviour change D10 already imposes.
 *
 * EVERY error is retried and there is no taxonomy. The SDK cannot tell your
 * transient DB error from a permanent one, and inventing a sentinel for you to
 * wrap fails ADR-102 C0.1's bar.
 */
export async function resolveProductRoles(
  handler: ProductRolesHandler | undefined,
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
      if (signal?.aborted) {
        throw new ProductRolesError(tenantId, userId, attempt, last);
      }
      await sleep(PRODUCT_ROLES_BACKOFF_MS[attempt - 1]!, signal);
    }
    try {
      return await handler(tenantId, userId, signal);
    } catch (err) {
      last = err;
      if (signal?.aborted) break;
    }
  }
  throw new ProductRolesError(tenantId, userId, PRODUCT_ROLES_ATTEMPTS, last);
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

/**
 * Wraps a failure of the ADR-102 D10 mint that follows `/auth/login`, and
 * CARRIES THE SESSION login already created.
 *
 * ## Why the session travels on the error
 *
 * ADR-102 OQ8: the session is not litter, it is the RECOVERY ANCHOR, and that is
 * the point of splitting login from the mint. Every mint-time refusal is
 * recoverable from the one refresh token login handed back:
 *
 * | refusal at mint | recovery, same refresh token |
 * |---|---|
 * | role handler failed for org A | choose org B — failures are often per-org |
 * | `412 mfa_required` | verify, then mint |
 * | `412 mfa_registration_required` | enroll a first factor, then mint |
 * | ADR-092 session limit | the issuer returns the ACTIVE SESSION LIST and a revocation token — a surface that only makes sense while you still hold a usable refresh token |
 *
 * A mint-or-nothing `login` would strand exactly the users those affordances
 * exist for. Throwing a bare error would have done precisely that, because a
 * caller's `catch` has no other handle on the session.
 *
 * The session is NOT revoked. The residual risk — a partner whose role DB is
 * down for every tenant burning ADR-092 session slots — is bounded by D11's
 * retries and by the sessions' own expiry, and is the cheaper failure of the two.
 */
export class LoginMintError extends Error {
  /** The session `/auth/login` created, intact and usable. */
  readonly session: unknown;
  /** The tenant the mint was attempted for. */
  readonly tenantId: string;
  /**
   * The underlying failure: a {@link ProductRolesError} when YOUR handler gave
   * up, or a `RealmError` when the ISSUER refused the mint.
   */
  readonly cause: unknown;

  constructor(session: unknown, tenantId: string, cause: unknown) {
    super(`login succeeded but the mint for tenant ${tenantId} failed: ${String(cause)}`);
    this.name = "LoginMintError";
    this.session = session;
    this.tenantId = tenantId;
    this.cause = cause;
  }
}
