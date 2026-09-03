package realmid

import (
	ctxpkg "context"
	"net/url"
)

// DriftReview is one queued contact-drift review (SPEC §6.8, ADR-042).
// When a returning user logs in with an identifier that differs from the
// one on file, the server enqueues a review instead of silently mutating
// the contact. Only `pending` rows are actionable. *At fields are unix
// seconds; Status ∈ pending|accepted|rejected|superseded|expired.
type DriftReview struct {
	ID                  string `json:"id"`
	ContactID           string `json:"contact_id"`
	UserID              string `json:"user_id"`
	AssertedValue       string `json:"asserted_value"`
	AssertedMethod      string `json:"asserted_method"`
	AssertedProviderUID string `json:"asserted_provider_uid"`
	SeenCount           int    `json:"seen_count"`
	FirstSeenAt         int64  `json:"first_seen_at"`
	LastSeenAt          int64  `json:"last_seen_at"`
	Status              string `json:"status"`
}

// DriftReviewListOpts filters DriftReviewsClient.List. Limit is 1..200
// (default 50 server-side).
type DriftReviewListOpts struct {
	UserID string
	Limit  int
}

// DriftAcceptResult is the response from DriftReviewsClient.Accept.
type DriftAcceptResult struct {
	ID            string `json:"id"`
	Status        string `json:"status"`
	AcceptedValue string `json:"accepted_value"`
	NewContactID  string `json:"new_contact_id"`
}

// DriftRejectResult is the response from DriftReviewsClient.Reject /
// RejectHard (ADR-080 Part 3). Mode is "soft" (default: dismiss the asserted
// change, keep the account and its binding, notify the owner) or "hard"
// (park the account by severing its provider binding). Parked +
// RevokedBindings are populated only on a hard reject.
type DriftRejectResult struct {
	ID              string `json:"id"`
	Status          string `json:"status"`
	Mode            string `json:"mode"`
	Parked          bool   `json:"parked,omitempty"`
	RevokedBindings int64  `json:"revoked_bindings,omitempty"`
}

// DriftReviewsClient is realm.Tenants.DriftReviews (SPEC §6.8).
type DriftReviewsClient struct {
	realm *Realm
}

// List paginates the tenant's contact-drift reviews. opts may be nil.
func (c *DriftReviewsClient) List(ctx ctxpkg.Context, tenantID string, opts *DriftReviewListOpts) *Paginated[DriftReview] {
	o := DriftReviewListOpts{}
	if opts != nil {
		o = *opts
	}
	path := "/tenants/" + url.PathEscape(tenantID) + "/contact-drift-reviews"
	return newPaginated(func(ctx ctxpkg.Context, po PageOpts) (*Page[DriftReview], error) {
		tok, err := c.realm.platformToken.get(ctx)
		if err != nil {
			return nil, err
		}
		q := map[string]string{}
		if po.Cursor != "" {
			q["cursor"] = po.Cursor
		}
		if o.UserID != "" {
			q["user_id"] = o.UserID
		}
		limit := po.Limit
		if limit == 0 {
			limit = o.Limit
		}
		if limit > 0 {
			q["limit"] = itoa(limit)
		}
		var env pageEnvelope[DriftReview]
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

// Accept adopts the asserted value as the user's new contact (releasing
// the old one). A review that is already resolved, or whose value now
// collides, fails RealmError(conflict) (409).
func (c *DriftReviewsClient) Accept(ctx ctxpkg.Context, tenantID, reviewID string) (*DriftAcceptResult, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out DriftAcceptResult
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/tenants/" + url.PathEscape(tenantID) + "/contact-drift-reviews/" + url.PathEscape(reviewID) + "/accept",
		Bearer: tok,
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Reject is a SOFT reject (ADR-080 Part 3, the default): dismiss the asserted
// identity change, keep the account and its original provider binding intact,
// and notify the original-email owner. Non-destructive. For the "this looks
// like a takeover" escalation that parks the account, use RejectHard.
func (c *DriftReviewsClient) Reject(ctx ctxpkg.Context, tenantID, reviewID string) (*DriftRejectResult, error) {
	return c.reject(ctx, tenantID, reviewID, false)
}

// RejectHard parks the account (ADR-080 Part 3): the provider binding is
// severed, leaving the account unmapped (NOT silently re-invited). Recovery is
// the explicit hand-back flow (UsersClient.HandBack). A deliberate,
// audited "this looks like a takeover" action.
func (c *DriftReviewsClient) RejectHard(ctx ctxpkg.Context, tenantID, reviewID string) (*DriftRejectResult, error) {
	return c.reject(ctx, tenantID, reviewID, true)
}

func (c *DriftReviewsClient) reject(ctx ctxpkg.Context, tenantID, reviewID string, hard bool) (*DriftRejectResult, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var body map[string]any
	if hard {
		body = map[string]any{"hard": true}
	}
	var out DriftRejectResult
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/tenants/" + url.PathEscape(tenantID) + "/contact-drift-reviews/" + url.PathEscape(reviewID) + "/reject",
		Bearer: tok,
		Body:   body,
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
