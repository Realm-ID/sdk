package realmid

import ctxpkg "context"

// orgSessionModeOf reports the realm's org-session mode for the token's
// issuer, for the login / refresh / MFA-verify bodies (SPEC §6.7.3).
// "concurrent" when it cannot be read.
func (r *Realm) orgSessionModeOf(ctx ctxpkg.Context, accessToken string) string {
	p, err := peekSession(accessToken)
	if err != nil || p.Iss == "" {
		return OrgSessionsConcurrent
	}
	return r.modes.mode(ctx, p.Iss)
}
