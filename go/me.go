package realmid

import (
	ctxpkg "context"
	"net/url"
)

// MeClient is realm.Me — the caller's own membership self-service (ADR-092
// D5). Every route here is authorized by the END USER, never by the platform
// credential alone: the subject is whoever the session says it is, so there is
// no tenant/user id path parameter naming someone else.
//
// Two auth modes, mirroring the rest of the SDK:
//   - DIRECT — set UserBearer to the user's access JWT; it becomes the wire
//     bearer.
//   - BFF — leave UserBearer empty and hand the SDK the user's verified access
//     JWT (UserToken, or WithUserToken(ctx, …)); the realm's platform token
//     rides as the bearer and the user JWT rides as `X-User-Token`. A BARE user
//     id is NOT an identity — the issuer removed that in v0.66.0 and answers
//     `401 x_user_token_required` — which is why there is no UserID mode here.
type MeClient struct {
	realm *Realm
}

// MeAuth is the end-user credential every realm.Me call needs. Exactly one of
// the two is enough; both empty falls back to a token stashed via
// WithUserToken(ctx, …).
type MeAuth struct {
	// UserBearer is the user's access JWT, used AS the bearer (direct mode).
	UserBearer string
	// UserToken is the user's verified access JWT forwarded as `X-User-Token`
	// alongside the platform bearer (BFF mode, ADR-056).
	UserToken string
}

// TenantChoiceRequest settles the ADR-092 D5 picker. TenantID is the
// membership to KEEP — the others in that realm are given up.
type TenantChoiceRequest struct {
	MeAuth
	TenantID string
}

// TenantChoiceResult is the outcome of MeClient.ChooseTenant.
type TenantChoiceResult struct {
	TenantID string `json:"tenant_id"`
	// Status is "chosen".
	Status string `json:"status"`
	// Released counts the memberships that were given up. They are SUSPENDED,
	// not deleted (a login-time picker should not be the most destructive
	// operation in the product), so an admin can restore one and the user can
	// still Leave deliberately.
	Released int `json:"released"`
}

// MembershipRequest names one of the caller's own memberships by tenant id.
type MembershipRequest struct {
	MeAuth
	TenantID string
}

// MembershipResult is the outcome of MeClient.RejectInvitation ("rejected")
// or MeClient.LeaveMembership ("left").
type MembershipResult struct {
	TenantID string `json:"tenant_id"`
	Status   string `json:"status"`
}

// bearer resolves the wire bearer + headers for a realm.Me call. Direct mode
// still mints the platform token (keeping the cache warm and surfacing mint
// errors), matching PassthroughOptions.UserBearer.
func (c *MeClient) bearer(ctx ctxpkg.Context, a MeAuth) (string, map[string]string, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return "", nil, err
	}
	if a.UserBearer != "" {
		return a.UserBearer, nil, nil
	}
	if a.UserToken != "" {
		return tok, map[string]string{"X-User-Token": a.UserToken}, nil
	}
	// Nothing explicit: httpClient.do forwards any WithUserToken(ctx, …) JWT
	// as X-User-Token on its own, so this is BFF mode with the token threaded
	// through the context instead of the request.
	return tok, nil, nil
}

// ChooseTenant answers the picker raised by Session.TenantChoiceRequired via
// POST /me/tenant-choice: keep req.TenantID, give up the caller's other
// memberships in that realm.
//
// An OWNED organization cannot be given up — `tenants.owner_user_id` is NOT
// NULL, so releasing the owner's membership would strand it. The server
// refuses with `409 owner_cannot_be_revoked` BEFORE mutating anything, so a
// rejected choice never leaves the caller half-reconciled; ownership must be
// transferred (ADR-076) first. `409 single_tenant_not_required` means the realm
// does not require single-tenant membership, so there was nothing to settle.
func (c *MeClient) ChooseTenant(ctx ctxpkg.Context, req TenantChoiceRequest) (*TenantChoiceResult, error) {
	bearer, headers, err := c.bearer(ctx, req.MeAuth)
	if err != nil {
		return nil, err
	}
	var out TenantChoiceResult
	if err := c.realm.http.do(ctx, requestOptions{
		Method:  "POST",
		Path:    "/me/tenant-choice",
		Bearer:  bearer,
		Headers: headers,
		Body:    map[string]any{"tenant_id": req.TenantID},
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// AcceptInvitation accepts a PENDING invitation to a tenant via
// POST /me/invitations/{tenantId}/accept.
//
// The mirror of RejectInvitation, and the reason both exist: a realm on
// `invitation_acceptance: "explicit"` (ADR-095 D2) no longer activates an
// invitation implicitly at login, so a decline path with no matching accept
// path would leave an invitee able to say no and unable to say yes.
//
// On a realm using the default `"auto"` mode this still works — it settles a
// row the invitee's next sign-in would have settled anyway. Only an offer can
// be accepted: an already-active membership answers `409 not_invited`, and an
// invitation already answered, revoked or expired answers `409 not_pending`.
// `404` deliberately does not distinguish "no such tenant" from "not yours".
func (c *MeClient) AcceptInvitation(ctx ctxpkg.Context, req MembershipRequest) (*MembershipResult, error) {
	return c.membershipOp(ctx, req, "/me/invitations/"+url.PathEscape(req.TenantID)+"/accept")
}

// RejectInvitation declines a PENDING invitation to a tenant via
// POST /me/invitations/{tenantId}/reject.
//
// Only an offer can be declined: an active member wanting out uses
// LeaveMembership instead, and the server keeps the two apart with `409
// not_invited` / `409 not_pending`. The outcome is recorded rather than
// deleted, and the live-invite unique index is partial, so the tenant MAY
// invite the same person again later. `404` deliberately does not distinguish
// "no such tenant" from "not yours" — that difference would be an existence
// oracle for tenant ids. A `501 invitations_unavailable` means the issuer runs
// without an invitation-lifecycle store.
func (c *MeClient) RejectInvitation(ctx ctxpkg.Context, req MembershipRequest) (*MembershipResult, error) {
	return c.membershipOp(ctx, req, "/me/invitations/"+url.PathEscape(req.TenantID)+"/reject")
}

// LeaveMembership ends the caller's own membership of a tenant via
// POST /me/memberships/{tenantId}/leave. It is the recovery path out of a
// picker-induced suspension, which is why it is authorized by the caller's
// realm session rather than a session in the tenant being left — requiring the
// latter would demand the very access this recovers from.
//
// Sessions for that membership are revoked, so leaving is not cosmetic for a
// token TTL. The tenant's OWNER is refused with `409 owner_cannot_leave`
// (transfer ownership first, ADR-076); an already-ended membership answers
// `409 already_left`.
func (c *MeClient) LeaveMembership(ctx ctxpkg.Context, req MembershipRequest) (*MembershipResult, error) {
	return c.membershipOp(ctx, req, "/me/memberships/"+url.PathEscape(req.TenantID)+"/leave")
}

// membershipOp runs the two no-body {tenant_id, status} routes.
func (c *MeClient) membershipOp(ctx ctxpkg.Context, req MembershipRequest, path string) (*MembershipResult, error) {
	bearer, headers, err := c.bearer(ctx, req.MeAuth)
	if err != nil {
		return nil, err
	}
	var out MembershipResult
	if err := c.realm.http.do(ctx, requestOptions{
		Method:  "POST",
		Path:    path,
		Bearer:  bearer,
		Headers: headers,
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
