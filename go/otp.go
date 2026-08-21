// Partner OTP primitive client (issue / view / verify) — see
// docs/proposals/partner-otp-primitive.md in the auth repo for design.
//
// All three calls require a tenant-scoped user/service identity. The
// SDK supports both shapes:
//
//   - UserBearer: legacy / public-client mode. The user's access JWT
//     rides as Authorization: Bearer.
//   - UserID:     BFF mode. The SDK uses its cached platform token as
//     bearer and forwards X-On-Behalf-Of-User: <UserID>.
//
// Mirrors the dual-token semantics of the existing user-scoped endpoints
// (sessions list / revoke).
package realmid

import (
	ctxpkg "context"
	"time"
)

// OTPClient implements the partner OTP primitive surface.
type OTPClient struct{ realm *Realm }

// IssueRequest names the entity an OTP is bound to and the partner-side
// purpose tag (free string, regex `^[a-z][a-z0-9_]{0,63}$`).
type IssueRequest struct {
	SubjectRef string
	Purpose    string
	// DeliveryMode selects how the OTP reaches the end-user (ADR-071 §4). v1
	// supports "view_bff" only (the plaintext Value is returned for BFF display
	// — use DeliveryModeViewBFF). Empty defers to the issuer default. A
	// purpose="login" OTP for a service account requires view_bff.
	DeliveryMode string

	// Auth: exactly one of UserID or UserBearer.
	UserID     string
	UserBearer string
	// OnBehalfOfIP, when set, rides as X-On-Behalf-Of-IP.
	OnBehalfOfIP string
}

// IssueResponse mirrors api/internal/httpapi otpIssueResp.
type IssueResponse struct {
	ID         string    `json:"id"`
	Value      string    `json:"value"`
	ExpiresAt  time.Time `json:"-"` // parsed from string field below
	ExpiresAtS string    `json:"expires_at"`
	Purpose    string    `json:"purpose"`
	SubjectRef string    `json:"subject_ref"`
}

// ViewResponse mirrors api/internal/httpapi otpViewResp.
type ViewResponse struct {
	ID           string    `json:"id"`
	Value        string    `json:"value"`
	ExpiresAt    time.Time `json:"-"`
	ExpiresAtS   string    `json:"expires_at"`
	Purpose      string    `json:"purpose"`
	SubjectRef   string    `json:"subject_ref"`
	IssuerUserID string    `json:"issuer_user_id"`
}

// VerifyRequest names the entity to match against and the value typed
// by the end-user (or the delivery agent, for delivery-confirmation
// flows).
type VerifyRequest struct {
	SubjectRef string
	Purpose    string
	Presented  string

	UserID       string
	UserBearer   string
	OnBehalfOfIP string
}

// VerifyResponse mirrors api/internal/httpapi otpVerifyResp.
type VerifyResponse struct {
	OTPID        string    `json:"otp_id"`
	IssuerUserID string    `json:"issuer_user_id"`
	IssuedAt     time.Time `json:"-"`
	IssuedAtS    string    `json:"issued_at"`
	SubjectRef   string    `json:"subject_ref"`
	Purpose      string    `json:"purpose"`
}

// Issue mints a fresh OTP. The plaintext Value is returned exactly once
// — partners deliver it out-of-band (manager UI display, SMS, email).
func (c *OTPClient) Issue(ctx ctxpkg.Context, req IssueRequest) (*IssueResponse, error) {
	bearer, headers, err := c.realm.Auth.resolveOnBehalfOf(ctx, req.UserID, req.UserBearer, req.OnBehalfOfIP, false)
	if err != nil {
		return nil, err
	}
	body := map[string]any{
		"subject_ref": req.SubjectRef,
		"purpose":     req.Purpose,
	}
	if req.DeliveryMode != "" {
		body["delivery_mode"] = req.DeliveryMode
	}
	var resp IssueResponse
	if err := c.realm.http.do(ctx, requestOptions{
		Method:  "POST",
		Path:    "/auth/otp/issue",
		Bearer:  bearer,
		Body:    body,
		Headers: headers,
	}, &resp); err != nil {
		return nil, err
	}
	if t, perr := time.Parse(time.RFC3339, resp.ExpiresAtS); perr == nil {
		resp.ExpiresAt = t
	}
	return &resp, nil
}

// View returns the plaintext value of an OTP — issuer-scoped: only the
// user who minted the OTP can fetch it (the manager who issued the
// code, not a colleague). Cross-issuer / cross-tenant attempts return
// 404 with no info leak.
func (c *OTPClient) View(ctx ctxpkg.Context, otpID string, opts ViewOptions) (*ViewResponse, error) {
	bearer, headers, err := c.realm.Auth.resolveOnBehalfOf(ctx, opts.UserID, opts.UserBearer, opts.OnBehalfOfIP, false)
	if err != nil {
		return nil, err
	}
	var resp ViewResponse
	if err := c.realm.http.do(ctx, requestOptions{
		Method:  "GET",
		Path:    "/auth/otp/" + otpID,
		Bearer:  bearer,
		Headers: headers,
	}, &resp); err != nil {
		return nil, err
	}
	if t, perr := time.Parse(time.RFC3339, resp.ExpiresAtS); perr == nil {
		resp.ExpiresAt = t
	}
	return &resp, nil
}

// ViewOptions selects the caller identity for OTPClient.View.
type ViewOptions struct {
	UserID       string
	UserBearer   string
	OnBehalfOfIP string
}

// Verify hash-matches a presented value against active OTP rows in
// (tenant, subject_ref, purpose). On success the matching row is
// consumed atomically — concurrent verifies can't double-spend.
//
// The response carries IssuerUserID + IssuedAt so the partner backend
// can attribute the action to the human who minted the code without a
// follow-up RealmID query.
func (c *OTPClient) Verify(ctx ctxpkg.Context, req VerifyRequest) (*VerifyResponse, error) {
	bearer, headers, err := c.realm.Auth.resolveOnBehalfOf(ctx, req.UserID, req.UserBearer, req.OnBehalfOfIP, false)
	if err != nil {
		return nil, err
	}
	body := map[string]any{
		"subject_ref": req.SubjectRef,
		"purpose":     req.Purpose,
		"presented":   req.Presented,
	}
	var resp VerifyResponse
	if err := c.realm.http.do(ctx, requestOptions{
		Method:  "POST",
		Path:    "/auth/otp/verify",
		Bearer:  bearer,
		Body:    body,
		Headers: headers,
	}, &resp); err != nil {
		return nil, err
	}
	if t, perr := time.Parse(time.RFC3339, resp.IssuedAtS); perr == nil {
		resp.IssuedAt = t
	}
	return &resp, nil
}
