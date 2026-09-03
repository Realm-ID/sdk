package realmid

import (
	ctxpkg "context"
	"net/url"
)

// ContactVerification is one first-login step-up gate row (SPEC §6.9,
// ADR-042). When a user logs in for the first time on an identifier slot
// recycled from a previously-released contact (the 30-day hold from
// UpdateUserContact), the login is held `pending` until a tenant admin
// approves it. State ∈ pending|active|rejected|revoked; ExpiresAt is
// present only while pending. CreatedAt/ExpiresAt are unix seconds.
type ContactVerification struct {
	ID          string `json:"id"`
	ContactID   string `json:"contact_id"`
	UserID      string `json:"user_id"`
	Method      string `json:"method"`
	ProviderUID string `json:"provider_uid"`
	State       string `json:"state"`
	CreatedAt   int64  `json:"created_at"`
	ExpiresAt   int64  `json:"expires_at,omitempty"`
}

// ContactVerificationListOpts filters ContactVerificationsClient.List.
// State defaults to "pending" server-side; Limit is 1..200 (default 50).
type ContactVerificationListOpts struct {
	State string
	Limit int
}

// ContactVerificationResult is the response from Approve/Reject.
type ContactVerificationResult struct {
	ID    string `json:"id"`
	State string `json:"state"`
}

// ContactVerificationsClient is realm.Tenants.ContactVerifications (SPEC §6.9).
type ContactVerificationsClient struct {
	realm *Realm
}

// List paginates the tenant's contact verifications. opts may be nil.
func (c *ContactVerificationsClient) List(ctx ctxpkg.Context, tenantID string, opts *ContactVerificationListOpts) *Paginated[ContactVerification] {
	o := ContactVerificationListOpts{}
	if opts != nil {
		o = *opts
	}
	path := "/tenants/" + url.PathEscape(tenantID) + "/contact-verifications"
	return newPaginated(func(ctx ctxpkg.Context, po PageOpts) (*Page[ContactVerification], error) {
		tok, err := c.realm.platformToken.get(ctx)
		if err != nil {
			return nil, err
		}
		q := map[string]string{}
		if po.Cursor != "" {
			q["cursor"] = po.Cursor
		}
		if o.State != "" {
			q["state"] = o.State
		}
		limit := po.Limit
		if limit == 0 {
			limit = o.Limit
		}
		if limit > 0 {
			q["limit"] = itoa(limit)
		}
		var env pageEnvelope[ContactVerification]
		if err := c.realm.http.do(ctx, requestOptions{
			Method: "GET",
			Path:   path,
			Bearer: tok,
			Query:  q,
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

// Approve admits the held login; the contact becomes verified/active.
// Already resolved, or the active slot is taken → RealmError(conflict) (409).
func (c *ContactVerificationsClient) Approve(ctx ctxpkg.Context, tenantID, verificationID string) (*ContactVerificationResult, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out ContactVerificationResult
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/tenants/" + url.PathEscape(tenantID) + "/contact-verifications/" + url.PathEscape(verificationID) + "/approve",
		Bearer: tok,
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Reject denies the held login.
func (c *ContactVerificationsClient) Reject(ctx ctxpkg.Context, tenantID, verificationID string) (*ContactVerificationResult, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out ContactVerificationResult
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/tenants/" + url.PathEscape(tenantID) + "/contact-verifications/" + url.PathEscape(verificationID) + "/reject",
		Bearer: tok,
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
