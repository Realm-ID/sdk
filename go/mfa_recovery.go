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
	bearer, headers, err := a.resolveOnBehalfOf(ctx, req.UserID, req.UserBearer, req.OnBehalfOfIP)
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
	bearer, headers, err := a.resolveOnBehalfOf(ctx, req.UserID, req.UserBearer, req.OnBehalfOfIP)
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
