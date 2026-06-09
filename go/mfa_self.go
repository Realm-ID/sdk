package realmid

import (
	ctxpkg "context"
)

// SelfEnrollMFARequest carries the inputs to AuthClient.SelfEnrollMFA
// (ADR-061). RefreshToken is the handle to the user's login session — the
// only credential a first-login user has, since the MFA gate withholds the
// access token. TenantID scopes the returned enroll-challenge to the
// MFA-required tenant. Method is optional (server defaults to "totp").
type SelfEnrollMFARequest struct {
	RefreshToken string
	TenantID     string
	Method       string
}

// MFAEnrollment is the result of AuthClient.SelfEnrollMFA — the shared TOTP
// secret, an otpauth:// provisioning URL for QR rendering, recovery codes,
// and an enroll-scoped MFA challenge the caller completes via MFAVerify to
// confirm the secret AND mint tokens in a single code entry.
type MFAEnrollment struct {
	Secret            string   `json:"secret"`
	QRURL             string   `json:"qr_url"`
	RecoveryCodes     []string `json:"recovery_codes"`
	MFAChallengeToken string   `json:"mfa_challenge_token"`
	TenantID          string   `json:"tenant_id"`
}

// DisableMFARequest carries the inputs to AuthClient.DisableMFA. Bearer
// trio (see SelfEnrollMFARequest's session-credential note) plus a step-up
// Code (required by the server before it removes the factor).
type DisableMFARequest struct {
	UserID       string
	UserBearer   string
	OnBehalfOfIP string

	Code string
}

// RevokeAllSessionsRequest carries the inputs to
// AuthClient.RevokeAllSessions. It carries the bearer trio only (UserID /
// UserBearer / OnBehalfOfIP); there is no request body.
type RevokeAllSessionsRequest struct {
	UserID       string
	UserBearer   string
	OnBehalfOfIP string
}

// SelfEnrollMFA bootstraps a first MFA factor for the user behind
// req.RefreshToken via POST /auth/mfa/enroll (ADR-061). It is refresh-authed
// (the refresh is the handle to the login session), so a first-login user who
// has no access token yet — the MFA gate withheld it — can still enroll; the
// same call serves a post-login user switching into an MFA-required tenant.
// In BFF realms the SDK's platform token rides as the bearer and the refresh
// travels in the body (mirroring Token). Returns the TOTP secret, a QR
// provisioning URL, recovery codes, and an enroll-scoped challenge to pass to
// MFAVerify. Server error codes (unsupported_method, already_enrolled (409),
// not_a_member (403), refresh_invalid (401)) surface as the usual RealmError.
func (a *AuthClient) SelfEnrollMFA(ctx ctxpkg.Context, req SelfEnrollMFARequest) (*MFAEnrollment, error) {
	tok, err := a.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	body := map[string]any{
		"refresh_token": req.RefreshToken,
		"tenant_id":     req.TenantID,
	}
	if req.Method != "" {
		body["method"] = req.Method
	}
	var out MFAEnrollment
	if err := a.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/auth/mfa/enroll",
		Bearer: tok,
		Body:   body,
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DisableMFA removes the current user's MFA factor via DELETE /auth/mfa.
// The server requires a step-up Code on the request body. Returns nil on
// success. Server error codes (missing_code, not_enrolled (400),
// unauthorized) surface as the usual RealmError.
func (a *AuthClient) DisableMFA(ctx ctxpkg.Context, req DisableMFARequest) error {
	bearer, headers, err := a.resolveOnBehalfOf(ctx, req.UserID, req.UserBearer, req.OnBehalfOfIP)
	if err != nil {
		return err
	}
	return a.realm.http.do(ctx, requestOptions{
		Method:  "DELETE",
		Path:    "/auth/mfa",
		Bearer:  bearer,
		Body:    map[string]any{"code": req.Code},
		Headers: headers,
	}, nil)
}

// RevokeAllSessions revokes every session for the current user via
// DELETE /auth/sessions. There is no request body. Returns nil on
// success. The server rejects revocation-class tokens with
// insufficient_scope, which surfaces as the usual RealmError.
func (a *AuthClient) RevokeAllSessions(ctx ctxpkg.Context, req RevokeAllSessionsRequest) error {
	bearer, headers, err := a.resolveOnBehalfOf(ctx, req.UserID, req.UserBearer, req.OnBehalfOfIP)
	if err != nil {
		return err
	}
	return a.realm.http.do(ctx, requestOptions{
		Method:  "DELETE",
		Path:    "/auth/sessions",
		Bearer:  bearer,
		Headers: headers,
	}, nil)
}
