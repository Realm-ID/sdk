package dev.realmid.sdk.auth;

/**
 * Fired by {@link IdentityResolvedHandler}, immediately before
 * {@link ProductRolesHandler} and {@link ScopesHandler} are resolved — see the
 * design doc {@code docs/design/pre-mint-hook.md} for the full contract.
 *
 * <p><b>Not the same as "before the mint".</b> On the login lanes the first
 * mint is {@code /auth/login} itself; this fires before the SECOND,
 * derived-claims mint through {@code /auth/token}. That is the seam where
 * identity and tenant are settled but the token in hand still carries neither
 * {@code product_roles} nor {@code scope}.
 *
 * <p><b>{@code userId} is the per-membership {@code users} row id (the JWT
 * {@code sub}), not a person.</b> A partner keying a mirror on {@code sub}
 * alone will split or collide humans across orgs; the key is
 * {@code (tenantId, sub)}.
 *
 * <p>{@code role} / {@code email} / {@code displayName} are best-effort and
 * may be empty; {@code flow}, {@code realmId}, {@code tenantId} and
 * {@code userId} are guaranteed non-empty.
 *
 * <p>Deliberately carries NO access token, NO refresh token, and no request
 * object — see §7.1 of the design doc for why. A Java record is immutable by
 * construction, so — unlike the Go pointer event — there is no mutation hazard
 * to guard against here.
 */
public record IdentityResolvedEvent(
        AuthFlow flow,
        String realmId,
        String tenantId,
        String userId,
        String role,
        String email,
        String displayName
) {}
