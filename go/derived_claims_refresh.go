package realmid

import (
	ctxpkg "context"
)

// derived_claims_refresh.go — resolving the per-mint claims on the REFRESH lane.
//
// # The bug this closes
//
// `mintProductRoles` ran on three lanes — Login, CompleteLogin, PasswordLogin —
// and every one of them is a LOGIN. Nothing ran on refresh, and the middleware's
// refresh minted with `{RefreshToken, TenantID, CustomClaims}` alone. So a
// BFF-fronted session carried `product_roles` for one access-TTL and then lost
// it for the rest of its life, while `product_roles.go` promised in writing that
// the handler "runs on EVERY mint, refresh included, and nothing caches".
//
// `scope` had the same hole with a sharper edge: the issuer NEVER stores `scope`
// on a session (deliberately, so it cannot go stale), so an unrequested claim is
// an absent one, and `ScopesFrom` reads absence as no granted authority. A
// ScopePolicy gate therefore starts denying everything one access-TTL into every
// session — which is why a partner refused to ship their ADR-097 cutover.
//
// # Why the resolution happens AFTER the mint
//
// A handler needs the user id, and the refresh lane does not have one: it holds
// a refresh token, and the subject is inside the ACCESS token it does not have
// yet. So the order is mint → read the subject → resolve → re-mint. The subject
// is read LOCALLY with peekJWTUserFields (no network, no verification round
// trip) from a token the issuer just signed and handed us.
//
// The alternative — peeking the subject off the EXPIRING access token the caller
// still holds — would save a round trip, but it reads a token we are explicitly
// not verifying (its expiry is the reason we are here at all) and it assumes the
// old token is still in hand at that point in the caller's deployment. A refresh
// is not on a human's critical path the way a login is, so the round trip is the
// cheaper mistake to make.

// enrichRefreshMint re-mints a freshly-refreshed token so it carries the
// derived claims, updating `out` in place.
//
// It is a NO-OP when neither handler is configured, and that guard is load
// bearing: it is what keeps the second round trip off every consumer who never
// adopts either claim. The cost is opt-in with the feature.
//
// An error from either handler REFUSES the refresh rather than minting without
// the claim. Minting anyway would hand back a token that reads as "no granted
// authority" to every gate — turning a transient blip in the partner's role
// store into an authorization outage that our own logs record as a clean 200.
// The same rule ProductRolesError already states, and the same rule the issuer
// applies to an undelivered OTP.
func (r *Realm) enrichRefreshMint(ctx ctxpkg.Context, out *MintResult, tenantID string) error {
	if r.cfg.ProductRoles == nil && r.cfg.Scopes == nil {
		return nil
	}
	if out == nil || out.RefreshToken == "" {
		// Nothing to re-mint against. A credential-bootstrapped session gets no
		// refresh token at all (ADR-089), so this is a legitimate shape and not
		// an error — there is simply no second mint to make.
		return nil
	}
	// Prefer the tenant the issuer actually settled on over the one we asked
	// for: on a tenant switch they differ, and resolving for the requested
	// tenant while the token is minted for another is a silent wrong answer.
	if out.TenantID != "" {
		tenantID = out.TenantID
	}
	userID, _, _, err := peekJWTUserFields(out.AccessToken)
	if err != nil || userID == "" {
		// Deliberately NOT an error. peek is a convenience over a token the
		// issuer signed; if its shape ever changes we degrade to today's
		// behaviour (the claim is omitted) rather than breaking every refresh.
		// The regression tests assert the subject reaches the handler, so this
		// branch cannot silently become the normal path without turning them red.
		return nil
	}

	roles, err := r.resolveProductRoles(ctx, tenantID, userID)
	if err != nil {
		return err
	}
	scopes, err := r.resolveScopes(ctx, tenantID, userID)
	if err != nil {
		return err
	}
	if len(roles) == 0 && len(scopes) == 0 {
		// Both empty means both claims would be omitted, so the re-mint could
		// only reproduce the token we are already holding. Skipping it also
		// keeps a handler that legitimately returns nothing from costing a round
		// trip on every refresh forever.
		return nil
	}

	// Re-mint against the ROTATED refresh token. The first mint already spent
	// the one the caller presented; re-using it would fail as a replay.
	mint, err := r.Auth.Token(ctx, TokenRequest{
		RefreshToken: out.RefreshToken,
		TenantID:     tenantID,
		ProductRoles: roles,
		Scope:        scopes,
	})
	if err != nil {
		return err
	}
	out.AccessToken = mint.AccessToken
	out.RefreshToken = mint.RefreshToken
	out.ExpiresIn = mint.ExpiresIn
	if mint.RefreshExp != 0 {
		out.RefreshExp = mint.RefreshExp
	}
	if mint.IdleTTL != 0 {
		out.IdleTTL = mint.IdleTTL
	}
	return nil
}
