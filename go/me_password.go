package realmid

import ctxpkg "context"

// SetPasswordRequest is the input to MeClient.SetPassword (`PUT /me/password`,
// ADR-104). CurrentPassword is required when a password already exists and is
// omitted on a first set (an empty value is not sent).
type SetPasswordRequest struct {
	MeAuth
	CurrentPassword string
	NewPassword     string
}

// PasswordSet is the result of MeClient.SetPassword. RevokedSIDs (ADR-104 R-e)
// are the sessions the issuer ended across the person's whole identity in the
// realm, never the calling session; the SDK has already written each into the
// SessionStore. Empty when none ended or the issuer predates the field.
type PasswordSet struct {
	Status      string
	RevokedSIDs []string
}

// SetPassword sets or changes the signed-in member's own password
// (`PUT /me/password`, ADR-104 R7e). Both /me lanes apply, as on every
// realm.Me call: the member's own bearer (UserBearer) or the BFF lane (platform
// token + UserToken / WithUserToken).
//
// A success ends every OTHER session of the person in the realm and keeps the
// caller's; the response's `revoked_sids` are written into the SessionStore
// before this returns, so a local verify refuses those tokens (a store write
// error is logged, never returned, as in Logout). Errors arrive typed by the
// SDK's usual mapping: `current_password_required`, `password_too_short` /
// `password_too_long`, `invalid_credentials` (wrong current password) and
// `verified_email_required` (409). The SDK does not pre-validate lengths. Both
// passwords are secrets and are never logged.
func (c *MeClient) SetPassword(ctx ctxpkg.Context, req SetPasswordRequest) (*PasswordSet, error) {
	bearer, headers, err := c.bearer(ctx, req.MeAuth)
	if err != nil {
		return nil, err
	}
	body := map[string]any{"new_password": req.NewPassword}
	if req.CurrentPassword != "" {
		body["current_password"] = req.CurrentPassword
	}
	var out struct {
		Status      string `json:"status"`
		RevokedSIDs any    `json:"revoked_sids"`
	}
	if err := c.realm.http.do(ctx, requestOptions{
		Method:  "PUT",
		Path:    "/me/password",
		Bearer:  bearer,
		Headers: headers,
		Body:    body,
	}, &out); err != nil {
		return nil, err
	}
	ids := logoutSessionIDs("", out.RevokedSIDs)
	c.realm.Auth.revokeLocally(ctx, ids)
	return &PasswordSet{Status: out.Status, RevokedSIDs: ids}, nil
}
