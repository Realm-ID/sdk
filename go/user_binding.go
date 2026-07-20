package realmid

import (
	ctxpkg "context"
	"net/url"
)

// DelinkContactResult is the response from UsersClient.DelinkContact
// (ADR-080 Part 2): the contact whose provider binding was severed and how
// many active contact_verifications rows were revoked.
type DelinkContactResult struct {
	Status          string `json:"status"`
	ContactID       string `json:"contact_id"`
	RevokedBindings int64  `json:"revoked_bindings"`
}

// HandBackResult is the response from UsersClient.HandBack (ADR-080 Part 3):
// the reactivated account and the email identity moved onto it.
type HandBackResult struct {
	Status string `json:"status"`
	UserID string `json:"user_id"`
	Email  string `json:"email"`
}

// DelinkContact severs a contact's provider binding (ADR-080 Part 2): every
// active contact_verifications row bound to the contact is revoked, leaving
// the user_contacts row ACTIVE but unmapped so a new provider identity can
// bind on the next verified login (subject to the Phase A verified-email
// gate). This is the explicit owner action that unblocks a
// contact_admin_required login — a different provider claiming an address
// already bound to another identity — without ever silently transferring the
// binding. Owner/admin only (users:manage). Idempotent.
func (c *UsersClient) DelinkContact(ctx ctxpkg.Context, tenantID, userID, contactID string) (*DelinkContactResult, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out DelinkContactResult
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path: "/tenants/" + url.PathEscape(tenantID) + "/users/" + url.PathEscape(userID) +
			"/contacts/" + url.PathEscape(contactID) + "/delink",
		Bearer: tok,
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// HandBack hands an account back (ADR-080 Part 3): the OLD account (userID,
// currently deactivated) is reactivated and the mistakenly-created NEW
// account's (fromUserID) current email identity is moved onto it, then the new
// account is disabled — the explicit, audited recovery for a drift/rebind that
// created a separate account. The user's next verified login rebinds the same
// provider UID to the old account. Owner/admin only (users:manage). A missing
// from_user_id / same user / source-with-no-email yields
// RealmError(bad_request); a deactivated-target requirement failure surfaces
// as RealmError(conflict).
func (c *UsersClient) HandBack(ctx ctxpkg.Context, tenantID, userID, fromUserID string) (*HandBackResult, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out HandBackResult
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/tenants/" + url.PathEscape(tenantID) + "/users/" + url.PathEscape(userID) + "/hand-back",
		Bearer: tok,
		Body:   map[string]any{"from_user_id": fromUserID},
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
