package realmid

import (
	ctxpkg "context"
	"strconv"
)

// MeContact is one entry of MeClient.ListContacts: one of the caller's own
// active contacts. The wire carries exactly these five fields.
type MeContact struct {
	// ID is the contact id the proof routes (SendContactProof) take.
	ID string `json:"id"`
	// Kind is "email" or "phone".
	Kind  string `json:"kind"`
	Value string `json:"value"`
	// Verified is true once the contact has been proven.
	Verified bool `json:"verified"`
	// TenantID is the membership the contact belongs to.
	TenantID string `json:"tenant_id"`
}

// ListContactsRequest is the input to MeClient.ListContacts.
type ListContactsRequest struct {
	MeAuth
	// Limit is the page size; 0 leaves it to the server.
	Limit int
}

// ListContacts pages the caller's own ACTIVE contacts via GET /me/contacts
// (issuer spec 0.63.0). Every id listed is one SendContactProof accepts, so a
// console can offer "verify this phone" without knowing a contact id up front.
// A released contact is not listed.
//
// Only a signed-in person may list: an API-key session or a platform bearer
// with no user token is `403 permission_cap_exceeded`.
func (c *MeClient) ListContacts(ctx ctxpkg.Context, req ListContactsRequest) *Paginated[MeContact] {
	return newPaginated(func(ctx ctxpkg.Context, po PageOpts) (*Page[MeContact], error) {
		bearer, headers, err := c.bearer(ctx, req.MeAuth)
		if err != nil {
			return nil, err
		}
		q := map[string]string{}
		if po.Cursor != "" {
			q["cursor"] = po.Cursor
		}
		limit := po.Limit
		if limit == 0 {
			limit = req.Limit
		}
		if limit > 0 {
			q["limit"] = strconv.Itoa(limit)
		}
		var env pageEnvelope[MeContact]
		if err := c.realm.http.do(ctx, requestOptions{
			Method:  "GET",
			Path:    "/me/contacts",
			Bearer:  bearer,
			Headers: headers,
			Query:   q,
		}, &env); err != nil {
			return nil, err
		}
		if env.Items == nil {
			return nil, &RealmError{Code: ErrCodeServerError, Message: "list endpoint did not return {items, next_cursor}"}
		}
		p := env.page()
		return &p, nil
	})
}
