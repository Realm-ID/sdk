package realmid

import (
	ctxpkg "context"
)

// Authenticator is one enrolled MFA factor returned by
// AuthClient.ListAuthenticators. Today only TOTP is supported, so the list
// has 0 or 1 entries; the shape is forward-compatible with multiple factors.
// CreatedAt / ConfirmedAt are unix seconds (ConfirmedAt is 0 until confirmed).
type Authenticator struct {
	Type        string `json:"type"`
	Confirmed   bool   `json:"confirmed"`
	CreatedAt   int64  `json:"created_at"`
	ConfirmedAt int64  `json:"confirmed_at"`
}

// AuthenticatorList is the response from AuthClient.ListAuthenticators: the
// caller's enrolled authenticator(s) plus how many backup/recovery codes
// remain unconsumed.
type AuthenticatorList struct {
	Authenticators       []Authenticator `json:"authenticators"`
	BackupCodesRemaining int             `json:"backup_codes_remaining"`
}

// ListAuthenticatorsRequest carries the bearer trio only (UserID / UserBearer
// / OnBehalfOfIP); there is no request body.
type ListAuthenticatorsRequest struct {
	UserID       string
	UserBearer   string
	OnBehalfOfIP string
}

// RegenerateRecoveryCodesRequest carries the bearer trio only. The endpoint is
// step-up gated (RequireFresh): a token without a recent TOTP yields
// RealmError(mfa_required) (412) until the user re-completes TOTP.
type RegenerateRecoveryCodesRequest struct {
	UserID       string
	UserBearer   string
	OnBehalfOfIP string
}

// RecoveryCodes is the response from AuthClient.RegenerateRecoveryCodes: the
// fresh set of one-time recovery codes, shown once. The previous set
// (including any still-unconsumed codes) is invalidated.
type RecoveryCodes struct {
	Status        string   `json:"status"`
	RecoveryCodes []string `json:"recovery_codes"`
}

// ListAuthenticators returns the current user's enrolled MFA authenticator(s)
// and remaining backup-code count via GET /auth/mfa/authenticators. A read —
// NOT MFA-gated.
func (a *AuthClient) ListAuthenticators(ctx ctxpkg.Context, req ListAuthenticatorsRequest) (*AuthenticatorList, error) {
	bearer, headers, err := a.resolveOnBehalfOf(ctx, req.UserID, req.UserBearer, req.OnBehalfOfIP, true)
	if err != nil {
		return nil, err
	}
	var out AuthenticatorList
	if err := a.realm.http.do(ctx, requestOptions{
		Method:  "GET",
		Path:    "/auth/mfa/authenticators",
		Bearer:  bearer,
		Headers: headers,
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RegenerateRecoveryCodes mints a fresh set of recovery codes for the current
// user via POST /auth/mfa/recovery/regenerate, invalidating the previous set.
// Requires a CONFIRMED enrollment (else RealmError(conflict), 409) and is
// gated on a FRESH TOTP within the elevated window (RealmError(mfa_required),
// 412, until re-verified). Codes are shown once and also emailed (ADR-079).
func (a *AuthClient) RegenerateRecoveryCodes(ctx ctxpkg.Context, req RegenerateRecoveryCodesRequest) (*RecoveryCodes, error) {
	bearer, headers, err := a.resolveOnBehalfOf(ctx, req.UserID, req.UserBearer, req.OnBehalfOfIP, true)
	if err != nil {
		return nil, err
	}
	var out RecoveryCodes
	if err := a.realm.http.do(ctx, requestOptions{
		Method:  "POST",
		Path:    "/auth/mfa/recovery/regenerate",
		Bearer:  bearer,
		Headers: headers,
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// finishMFASession is the post-verify handling shared by every lane that
// completes an MFA challenge (MFAVerify, RedeemRecoveryCode): normalise the
// tenants and user id, then run the ADR-102 D10 mint under the given flow.
// On a mint failure it returns a *LoginMintError carrying the session.
func (a *AuthClient) finishMFASession(ctx ctxpkg.Context, resp *Session, flow AuthFlow) error {
	// The same normalisation every other session-producing lane does. MFAVerify
	// did none of it and returned the raw response, which is why the mint below
	// had no user id to resolve against even once it was added.
	for i := range resp.Tenants {
		if resp.Tenants[i].ID == "" && resp.Tenants[i].IDLegacy != "" {
			resp.Tenants[i].ID = resp.Tenants[i].IDLegacy
		}
	}
	if resp.User.ID == "" && resp.AccessToken != "" {
		if sub, email, name, perr := peekJWTUserFields(resp.AccessToken); perr == nil {
			resp.User.ID = sub
			if resp.User.Email == "" {
				resp.User.Email = email
			}
			if resp.User.DisplayName == "" {
				resp.User.DisplayName = name
			}
		}
	}
	// ADR-102 D10 — a step-up is the point at which the token the user carries
	// for the rest of the session is issued, so it is the LAST lane that may
	// hand back a claim-blind one. Without this, a partner who requires MFA has
	// every human denied by their own ScopePolicy gate immediately after
	// passing the second factor — the worst possible moment for it.
	if tenantID := settledTenant(resp); tenantID != "" {
		if err := a.mintProductRoles(ctx, resp, flow, tenantID, nil); err != nil {
			return &LoginMintError{Session: resp, TenantID: tenantID, Err: err}
		}
	}
	return nil
}

// RedeemRecoveryCode completes an MFA challenge with a single-use recovery code
// in place of the TOTP code, via POST /auth/mfa/recovery (ADR-077 §2, SPEC
// §4.3a). Post-verify handling is identical to MFAVerify, under FlowMFARecovery.
// The code is consumed and the returned Session has ReenrollRequired set: the
// old authenticator is cleared, so the user must re-enroll. Errors: 401 for an
// invalid challenge or code, 429 mfa_too_many_fails.
//
// When req.RefreshToken is set the call runs under the per-session refresh lock
// (go 0.64.2; see RedeemRecoveryCodeRequest.RefreshToken).
func (a *AuthClient) RedeemRecoveryCode(ctx ctxpkg.Context, req RedeemRecoveryCodeRequest) (*Session, error) {
	var out *Session
	err := a.realm.withSessionLock(ctx, req.RefreshToken, func(c ctxpkg.Context) (string, error) {
		var err error
		out, err = a.redeemRecoveryCode(c, req)
		return rotatedRefreshToken(out, err), err
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (a *AuthClient) redeemRecoveryCode(ctx ctxpkg.Context, req RedeemRecoveryCodeRequest) (*Session, error) {
	tok, err := a.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	headers := map[string]string{}
	if req.OnBehalfOfIP != "" {
		headers["X-On-Behalf-Of-IP"] = req.OnBehalfOfIP
	}
	var resp Session
	if err := a.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/auth/mfa/recovery",
		Bearer: tok,
		Body: map[string]any{
			"realm_id":            a.realm.realmID,
			"mfa_challenge_token": req.ChallengeToken,
			"code":                req.Code,
		},
		Headers: headers,
	}, &resp); err != nil {
		return nil, err
	}
	if err := a.finishMFASession(ctx, &resp, FlowMFARecovery); err != nil {
		return nil, err
	}
	return &resp, nil
}
