/**
 * identity-resolved.ts — `OnIdentityResolved`, the post-identity,
 * pre-derived-claims hook (design doc: `../docs/design/pre-mint-hook.md`).
 *
 * ## The problem this closes
 *
 * A partner resolving `product_roles` / `scope` in {@link ProductRolesHandler}
 * / {@link ScopesHandler} reads their OWN local mirror of the user, written by
 * a post-auth reconciler. On a brand-new user's first login, the mint happens
 * before that reconciler has ever run, so the resolvers read a row that does
 * not exist yet and the token comes back claim-blind. The resolvers cannot
 * seed the row themselves — side-effect freedom is their contract, and the SDK
 * retries them (`resolveProductRoles`, `resolveScopes`), so a write inside one
 * would run up to three times per mint.
 *
 * `onIdentityResolved` is the seam immediately before those two resolvers:
 * identity and tenant are settled, nothing has been resolved yet, and it runs
 * EXACTLY ONCE — never retried.
 *
 * ## The guarantee, stated so it is checkable
 *
 * Fires exactly once per derived-claims resolution, immediately before
 * `ProductRoles` and `Scopes` are resolved, on every lane where they are
 * resolved — login, otp, password, mfa_verify, tenant_choice (`completeLogin`,
 * including a later tenant SWITCH) and refresh. It does NOT fire on a direct
 * `Auth.token()` call, on a credential-bootstrapped session (no identity to
 * resolve), or on a lane that never mints.
 *
 * ## Its error refuses the mint, unconditionally — no fail-open knob
 *
 * The identical veto already exists via `Config.Scopes` today: a partner's
 * scope store being down already fails every login on that realm. Fail-open
 * would mint a token whose `scope` was resolved against a row the partner
 * meant to seed but couldn't — a CONFIDENTLY WRONG authority claim, not a
 * degraded read. A partner who wants best-effort behaviour writes `return`
 * after handling their own error inside the handler; that is strictly more
 * expressive than a second configuration surface saying the same thing, and
 * adding a knob later is additive where removing one is breaking.
 *
 * It can only fail the MINT, never the authentication: by the time this runs,
 * the issuer has already authenticated the principal and created a session.
 * On the login lanes the session rides back on {@link LoginMintError} — see
 * that class for why. On refresh the presented refresh token has already
 * rotated, so a hook error there is an unrecoverable logout; that hazard is
 * already true for a failing `Scopes` handler today, and this hook does not
 * add a new class of it.
 *
 * ## No synthetic deadline
 *
 * The hook receives no bounded context of its own. The SDK cannot bound
 * `ScopesHandler` / `ProductRolesHandler` today either, so a deadline
 * enforced only on this hook would be theatre — the caller's own timeout is
 * the honest bound, exactly as it is for its siblings.
 *
 * ## Not retried; must be idempotent
 *
 * A user can retry a failed login (which fires the hook again from the top),
 * and a tenant switch re-fires it for a second tenant. **Upsert, do not
 * insert.** The SDK keeps no "already fired" memo — a memo would need an
 * identity key, a TTL and an eviction policy with no right answer at this
 * layer, and would silently stop firing after a partner restored their own
 * database from backup.
 */

/**
 * Which lane produced this identity resolution. A partner who wants
 * once-per-authentication (rather than once-per-mint) opts out of the
 * per-access-TTL refresh write with one line: `if (ev.flow === "refresh")
 * return;`.
 */
export type AuthFlow =
  | "login"
  | "otp"
  | "password"
  | "mfa_verify"
  | "tenant_choice"
  | "refresh";

/**
 * What the hook is told. Deliberately excludes the access token, the refresh
 * token and any framework request object — see the design doc §7.1 for why:
 * the token in hand at this instant carries no `scope` / `product_roles` yet,
 * so handing it to a partner whose job is a database write would only invite
 * exactly the "absent scope means no authority" misreading this seam exists to
 * prevent.
 *
 * Mutating this object has no effect: `tenantId` and `userId` are already
 * captured locally before the hook runs, and nothing re-reads the event
 * afterward. If the hook could change tenant or role, the resolution that
 * follows would resolve for something the issuer never authenticated.
 */
export interface IdentityResolvedEvent {
  readonly flow: AuthFlow;
  readonly realmId: string;
  readonly tenantId: string;
  /** The per-membership `users` row id — the JWT `sub`, not a person. A
   *  mirror keyed on `sub` alone will split or collide humans across orgs;
   *  key on `(tenantId, userId)`. */
  readonly userId: string;
  /** Best-effort; `""` on the refresh lane, where the issuer's session
   *  response carries no role. */
  readonly role: string;
  /** Best-effort; may be `""`. */
  readonly email: string;
  /** Best-effort; may be `""`. */
  readonly displayName: string;
}

/**
 * Resolves the partner's own post-identity side effect — typically seeding
 * the local user row that `ProductRolesHandler` / `ScopesHandler` reads.
 *
 * ⚠️ Unlike its two siblings, this handler is EXPECTED to have side effects —
 * that is the entire reason it exists — but it is called EXACTLY ONCE per
 * derived-claims resolution, never retried. **It must therefore be
 * idempotent**: upsert, don't insert.
 *
 * Throwing (or rejecting) refuses the mint — see the module doc comment for
 * why there is no fail-open knob. A partner who wants best-effort behaviour
 * returns normally after handling their own error.
 */
export type IdentityResolvedHandler = (
  ev: IdentityResolvedEvent,
  signal?: AbortSignal,
) => Promise<void> | void;

/**
 * Reports that `onIdentityResolved` failed and the SDK therefore refused to
 * mint.
 *
 * ⚠️ Deliberately NOT a `RealmError`, for the same reason `ProductRolesError`
 * and `ScopesError` are not: "your hook failed" and "RealmID refused your
 * mint" are different incidents and must not look alike in your logs — one is
 * your database, the other is ours.
 *
 * Unlike its two siblings, this is NOT a retry-exhaustion report — the hook is
 * called exactly once — so there is no `attempts` field.
 */
export class IdentityResolvedError extends Error {
  readonly flow: AuthFlow;
  readonly tenantId: string;
  readonly userId: string;
  readonly cause?: unknown;

  constructor(ev: IdentityResolvedEvent, cause?: unknown) {
    super(
      `onIdentityResolved failed for tenant ${ev.tenantId} (flow=${ev.flow}): ${String(cause)}`,
    );
    this.name = "IdentityResolvedError";
    this.flow = ev.flow;
    this.tenantId = ev.tenantId;
    this.userId = ev.userId;
    this.cause = cause;
  }
}

/**
 * Fires the hook exactly once. A no-op when no handler is configured.
 *
 * ⚠️ NOT retried — the D11/scopes retry policy exists because those resolvers
 * are contractually side-effect-free; this handler is the side-effecting twin
 * and retrying it would run a partner's write up to three times per mint.
 */
export async function fireIdentityResolved(
  handler: IdentityResolvedHandler | undefined,
  ev: IdentityResolvedEvent,
  signal?: AbortSignal,
): Promise<void> {
  if (!handler) return;
  try {
    await handler(ev, signal);
  } catch (err) {
    throw new IdentityResolvedError(ev, err);
  }
}
