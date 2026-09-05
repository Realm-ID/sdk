package dev.realmid.sdk.auth;

/**
 * Fires once identity AND tenant are settled, immediately before
 * {@link ProductRolesHandler} and {@link ScopesHandler} run — the seam a
 * partner needs to seed the local row those two handlers read.
 *
 * <p><b>This is a side-effecting hook, not a resolver.</b> Unlike
 * {@link ProductRolesHandler} / {@link ScopesHandler}, it is NOT retried:
 * exactly one invocation per derived-claims resolution. Writing here is safe
 * because the SDK will not call it again for you — see the class-level "NOT
 * retried" note below.
 *
 * <h2>The error refuses the mint, unconditionally</h2>
 *
 * <p>An exception here refuses the mint — the same veto
 * {@link ScopesHandler#resolve} already holds today, just moved to a
 * non-retried function. There is no fail-open configuration knob: a partner
 * who wants best-effort behaviour catches their own error and returns
 * normally.
 *
 * <p><b>⚠️ It can only fail the DELIVERY of a session, never the
 * authentication.</b> By the time this runs, the issuer has already
 * authenticated the principal and created a session. On the login lanes the
 * session rides the thrown {@link LoginMintException} (the ADR-102 OQ8
 * recovery anchor) so it is never discarded. On the middleware refresh lane
 * the refresh token has ALREADY rotated by the time this runs, so a thrown
 * error there is an unrecoverable logout — not a new hazard, the identical
 * one a failing {@link ScopesHandler} already causes today.
 *
 * <h2>Fires on every lane that resolves the derived claims, refresh included</h2>
 *
 * <p>All three middlewares require {@code tenant_id} on the refresh route and
 * none has a separate tenant-choice route, so in a BFF deployment the refresh
 * route IS the tenant-choice route — the moment a brand-new
 * {@code (user, tenant)} pair most often first appears. A partner who wants
 * once-per-authentication opts out with one line:
 * {@code if (ev.flow() == AuthFlow.REFRESH) return;}
 *
 * <h2>Idempotency — required, and un-enforced</h2>
 *
 * <p>The SDK does not retry this handler and keeps no "already fired" memo: a
 * user retrying a failed login, or switching tenants, re-fires it. Upsert, do
 * not insert.
 *
 * <h2>No timeout, no race</h2>
 *
 * <p>This runs on the login hot path with a human waiting. The SDK passes no
 * synthetic deadline and will not interrupt it — it cannot bound
 * {@link ScopesHandler} today either, so bounding only this hook would be
 * theatre. Honour your own caller's timeout.
 *
 * <h2>Do NOT branch authorization on this alone</h2>
 *
 * <p>This hook seeds a row; it does not itself grant anything. Authorization
 * still flows from {@link ScopesHandler}'s {@code scope} claim.
 */
@FunctionalInterface
public interface IdentityResolvedHandler {
    void onIdentityResolved(IdentityResolvedEvent event) throws Exception;
}
