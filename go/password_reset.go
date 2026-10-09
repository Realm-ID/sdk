package realmid

import (
	ctxpkg "context"
	"net/url"
	"time"
)

// PasswordResetInspection is the result of AuthClient.InspectPasswordReset
// (ADR-111, SPEC §4.10). A 200 is not a reservation: the token can still expire
// or be used before ConsumePasswordReset runs.
type PasswordResetInspection struct {
	ExpiresAt time.Time `json:"expires_at"`
}

// PasswordResetSent is the result of UsersClient.SendPasswordReset (SPEC §6.3).
// To is MASKED by the issuer (first character + domain); show it as-is and never
// try to unmask it.
type PasswordResetSent struct {
	Status    string    `json:"status"`
	To        string    `json:"to"`
	ExpiresAt time.Time `json:"expires_at"`
}

// SetCredentialsRequest is the body of UsersClient.SetCredentials. An empty
// field is not sent; at least one is required (the issuer answers
// `400 bad_request` otherwise).
type SetCredentialsRequest struct {
	Username string
	Password string
}

type passwordResetStatus struct {
	Status string `json:"status"`
}

// InspectPasswordReset asks whether a reset-link token is still usable
// (ADR-111, SPEC §4.10) without writing anything, so a page can show invalid /
// expired / used / superseded BEFORE asking for a password.
//
// The token goes in the POST body only, never a query string, and is never
// logged. The SDK sends its platform bearer as on every auth call, which pins
// the call to the configured realm: a link minted in another realm answers
// `reset_token_invalid`. Parsing the token out of the link's URL fragment is the
// page's job. Errors: reset_token_invalid, reset_token_expired,
// reset_token_used, reset_token_superseded.
func (a *AuthClient) InspectPasswordReset(ctx ctxpkg.Context, token string) (*PasswordResetInspection, error) {
	tok, err := a.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out PasswordResetInspection
	if err := a.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/auth/password/reset/inspect",
		Bearer: tok,
		Body:   map[string]any{"token": token},
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ConsumePasswordReset sets the password a reset link was sent for (ADR-111,
// SPEC §4.10). It mints NO session: send the holder to PasswordLogin, where
// every MFA and eligibility gate lives. The SDK does not know the identifier and
// must not chain a login onto a consume.
//
// NEVER retried by the SDK: a consume replayed after a lost response answers
// `reset_token_used` even though the password WAS set. A page that gets
// `reset_token_used` right after its own submit should say "your password may
// already be set — try signing in". Length rules are the issuer's
// (`password_too_short` / `password_too_long` arrive as
// Details["server_code"]); the SDK does not pre-validate. The token and
// newPassword are secrets and are never logged.
func (a *AuthClient) ConsumePasswordReset(ctx ctxpkg.Context, token, newPassword string) error {
	tok, err := a.realm.platformToken.get(ctx)
	if err != nil {
		return err
	}
	var out passwordResetStatus
	return a.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/auth/password/reset",
		Bearer: tok,
		Body:   map[string]any{"token": token, "new_password": newPassword},
	}, &out)
}

// SendPasswordReset emails the member a single-use, 30-minute password-reset
// link (ADR-111, SPEC §6.3). No field names the address: the issuer picks the
// member's first active verified email. It changes no credential and revokes no
// session. Needs `users:manage` in the tenant. Errors: no_verified_email (409),
// reset_throttled (429), user_not_found (404); `unknown_method` and
// `bad_request` arrive per SPEC §6.3.
func (c *UsersClient) SendPasswordReset(ctx ctxpkg.Context, tenantID, userID string) (*PasswordResetSent, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out PasswordResetSent
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/tenants/" + url.PathEscape(tenantID) + "/users/" + url.PathEscape(userID) + "/password-reset",
		Bearer: tok,
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SetCredentials sets a member's username and/or hands over a TEMPORARY password
// (ADR-111, SPEC §6.3). A password set here is stored must-change: the holder
// replaces it at first sign-in (PasswordLoginRequest.NewPassword). Needs
// `users:manage`.
//
// `reset_link_required` (409): the member has a verified email, so nothing was
// written, the username included. Call SendPasswordReset instead; a caller that
// wants the username anyway re-sends it alone. `verified_email_required` (409):
// the realm's password_policy.require_verified_email is on and the member has no
// verified email. The SDK does not pre-check the member's contacts: the issuer
// decides at write time.
func (c *UsersClient) SetCredentials(ctx ctxpkg.Context, tenantID, userID string, req SetCredentialsRequest) error {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return err
	}
	body := map[string]any{}
	if req.Username != "" {
		body["username"] = req.Username
	}
	if req.Password != "" {
		body["password"] = req.Password
	}
	return c.realm.http.do(ctx, requestOptions{
		Method: "PUT",
		Path:   "/tenants/" + url.PathEscape(tenantID) + "/users/" + url.PathEscape(userID) + "/credentials",
		Bearer: tok,
		Body:   body,
	}, nil)
}
