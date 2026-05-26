package realmid

import (
	ctxpkg "context"
)

// EnrollMFARequest carries the inputs to AuthClient.EnrollMFA. It is a
// current-user op: set exactly one of UserID (BFF mode → platform token
// + X-On-Behalf-Of-User) or UserBearer (legacy / public-client mode →
// the user's own access JWT). OnBehalfOfIP, when set, rides as
// X-On-Behalf-Of-IP for per-IP rate-limit attribution.
type EnrollMFARequest struct {
	UserID       string
	UserBearer   string
	OnBehalfOfIP string

	// Method is the MFA method to enroll. Empty omits the field from the
	// wire body; the server defaults to "totp".
	Method string
}

// MFAEnrollment is the result of AuthClient.EnrollMFA — the shared TOTP
// secret, an otpauth:// provisioning URL for QR rendering, and one-time
// recovery codes.
type MFAEnrollment struct {
	Secret        string   `json:"secret"`
	QRURL         string   `json:"qr_url"`
	RecoveryCodes []string `json:"recovery_codes"`
}

// ConfirmMFARequest carries the inputs to AuthClient.ConfirmMFA. Bearer
// trio (see EnrollMFARequest) plus the TOTP Code the user typed. Method
// is optional and omitted from the wire body when empty.
type ConfirmMFARequest struct {
	UserID       string
	UserBearer   string
	OnBehalfOfIP string

	Code   string
	Method string
}

// DisableMFARequest carries the inputs to AuthClient.DisableMFA. Bearer
// trio (see EnrollMFARequest) plus a step-up Code (required by the
// server before it removes the factor).
type DisableMFARequest struct {
	UserID       string
	UserBearer   string
	OnBehalfOfIP string

	Code string
}

// RevokeAllSessionsRequest carries the inputs to
// AuthClient.RevokeAllSessions. It carries the bearer trio only (see
// EnrollMFARequest); there is no request body.
type RevokeAllSessionsRequest struct {
	UserID       string
	UserBearer   string
	OnBehalfOfIP string
}

// EnrollMFA begins self-service MFA enrollment for the current user via
// POST /auth/mfa/enroll. The user identifies either via UserBearer
// (legacy / public-client realms) or UserID + the SDK's platform token
// (BFF realms). Returns the TOTP secret, a QR provisioning URL, and
// recovery codes. Server error codes (unsupported_method,
// already_enrolled (409), unauthorized) surface as the usual RealmError.
func (a *AuthClient) EnrollMFA(ctx ctxpkg.Context, req EnrollMFARequest) (*MFAEnrollment, error) {
	bearer, headers, err := a.resolveOnBehalfOf(ctx, req.UserID, req.UserBearer, req.OnBehalfOfIP)
	if err != nil {
		return nil, err
	}
	body := map[string]any{}
	if req.Method != "" {
		body["method"] = req.Method
	}
	var out MFAEnrollment
	if err := a.realm.http.do(ctx, requestOptions{
		Method:  "POST",
		Path:    "/auth/mfa/enroll",
		Bearer:  bearer,
		Body:    body,
		Headers: headers,
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ConfirmMFA completes self-service MFA enrollment via
// POST /auth/mfa/confirm by proving possession of the freshly-enrolled
// factor (the TOTP Code). Returns nil on success. Server error codes
// (missing_code, not_enrolled (400), unauthorized) surface as the usual
// RealmError.
func (a *AuthClient) ConfirmMFA(ctx ctxpkg.Context, req ConfirmMFARequest) error {
	bearer, headers, err := a.resolveOnBehalfOf(ctx, req.UserID, req.UserBearer, req.OnBehalfOfIP)
	if err != nil {
		return err
	}
	body := map[string]any{"code": req.Code}
	if req.Method != "" {
		body["method"] = req.Method
	}
	return a.realm.http.do(ctx, requestOptions{
		Method:  "POST",
		Path:    "/auth/mfa/confirm",
		Bearer:  bearer,
		Body:    body,
		Headers: headers,
	}, nil)
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
