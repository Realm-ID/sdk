package realmid

import (
	ctxpkg "context"
)

// InvitationInspection is the answer to AuthClient.InspectInvitation: enough to
// render "Join <org>" before asking for a username (ADR-117 D6).
type InvitationInspection struct {
	TenantID          string `json:"tenant_id"`
	TenantDisplayName string `json:"tenant_display_name"`
	// ExpiresAt is an RFC 3339 timestamp, as the issuer sends it.
	ExpiresAt string `json:"expires_at"`
}

// InspectInvitation checks an invitation sign-up link via
// POST /auth/invitations/inspect (ADR-117 D6). Anonymous: the token IS the
// credential, sent in the BODY, never a URL. Writes and consumes nothing.
//
// Every dead link answers the same `400 invalid_invitation_token` (unknown,
// malformed, used, expired, superseded by a resend, withdrawn, or the
// membership is no longer invited): there is no oracle to tell them apart.
func (a *AuthClient) InspectInvitation(ctx ctxpkg.Context, token string) (*InvitationInspection, error) {
	tok, err := a.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out InvitationInspection
	if err := a.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/auth/invitations/inspect",
		Bearer: tok,
		Body:   map[string]any{"token": token},
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// AcceptInvitationRequest is the input to AuthClient.AcceptInvitation.
type AcceptInvitationRequest struct {
	// Token is the value from the sign-up link.
	Token string
	// Username is 3-32 characters, case-folded, unique per org.
	Username string
	// Password is 12..1024 bytes, no composition rules. The SDK does not
	// pre-validate it; the issuer answers `password_too_short` / `password_too_long`
	// (Details["server_code"]) BEFORE touching the token, so a rejected password
	// does not burn the link.
	Password string
	// Origin overrides the realm's configured Origin, as on PasswordLogin.
	Origin string
}

// AcceptInvitation creates the username and password for an invited membership
// and signs the person in, via POST /auth/invitations/accept (ADR-117 D6).
//
// The result is EXACTLY PasswordLogin's: a signed-in *Session, or the MFA
// challenge / first-login enrolment response, from the same completion code
// (every MFA floor and session limit applies, and the SDK mints product roles
// the same way). Accepting NEVER proves the address the link went to.
//
// Errors: `400 invalid_invitation_token`, `invalid_username`; `409
// identifier_collision` (username taken in that org). The SDK never retries it.
func (a *AuthClient) AcceptInvitation(ctx ctxpkg.Context, req AcceptInvitationRequest) (*Session, error) {
	tok, err := a.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	headers := map[string]string{}
	origin := req.Origin
	if origin == "" {
		origin = a.realm.cfg.Origin
	}
	if origin == "" {
		if info, ierr := a.realm.info.Info(ctx); ierr == nil {
			origin = inferOrigin(info)
		}
	}
	if origin != "" {
		headers["Origin"] = origin
	}
	body := map[string]any{
		"token":    req.Token,
		"username": req.Username,
		"password": req.Password,
	}
	return a.passwordShapedLogin(ctx, "/auth/invitations/accept", tok, body, headers)
}
