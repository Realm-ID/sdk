package dev.realmid.sdk.auth;

/**
 * ADR-097 GRANTED AUTHORITY — resolves the PARTNER's own scope strings for a
 * principal in one org, which the SDK mints onto the access token's
 * {@code scope} claim.
 *
 * <p>This is the {@code scope} twin of {@link ProductRolesHandler}, and the two
 * are deliberately shaped identically: one realm-level handler, run at every
 * mint, its result carried onto the token. They answer different questions —
 * {@code scope} is a GRANT and {@code product_roles} is a NAME — but they are
 * resolved by the same mechanism because they have the same freshness
 * requirement.
 *
 * <h2>Why a handler at all, rather than a field on the request</h2>
 *
 * <p>{@link TokenRequest#scope()} only reaches mints a partner writes BY HAND.
 * In a BFF deployment humans mint through {@code RealmFilter}, which builds the
 * request itself and never exposes it — so the per-call field is, for the lane
 * that carries every human session, unreachable. That is not hypothetical: a
 * partner hit it, and the integration guide had to be corrected for pointing at
 * the per-call field instead of the realm-level handler.
 *
 * <p><b>⚠️ SIDE-EFFECT FREEDOM IS A CONTRACT, NOT A SUGGESTION.</b> The SDK
 * calls this an UNSPECIFIED NUMBER OF TIMES per mint — it retries on error — so
 * the handler MUST NOT write, bill, audit, or emit. A partner who logs "scopes
 * resolved" inside it will see triple entries and be right to call it a bug.
 * Retrying is only legal because this is specified as a pure read.
 *
 * <p>It runs on EVERY mint, refresh included, and nothing caches. That is the
 * whole point: the issuer NEVER stores {@code scope} on a session —
 * deliberately, so it cannot go stale — so an unrequested claim is an ABSENT
 * one, and absent reads as "no granted authority" in every SDK gate
 * ({@code Scopes.scopesFrom}, {@code ScopePolicy}, {@code ScopeFilter}). A
 * session whose scopes are resolved only at login therefore loses its authority
 * at the first refresh.
 *
 * <p>Returning an empty list or null mints NO claim, not {@code []}. Absent and
 * empty must mean the same thing here: every token issued before ADR-097 has no
 * claim at all, so a reader handles absence regardless.
 *
 * <p><b>⚠️ That rule is NOT shared with {@code rolePermissions}</b>, where an
 * empty non-null list is a real instruction ("this role confers nothing here")
 * that the issuer answers with a 403. The asymmetry is deliberate; do not
 * harmonise it.
 */
@FunctionalInterface
public interface ScopesHandler {
    java.util.List<String> resolve(String tenantId, String userId) throws Exception;
}
