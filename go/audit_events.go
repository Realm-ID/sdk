// Partner audit-event feed (ADR-055, SPEC §7.6).
//
// The partner-facing slice of audit_log. Same row shape as the internal
// /admin/events surface, scoped (and forced) to the platform the SDK is
// authenticated for — the SDK takes the platform-id from realm.RealmID()
// and the server ignores any query-string platform_id, so callers cannot
// read another platform's events.

package realmid

import (
	ctxpkg "context"
	"strconv"
	"strings"
)

// AuditEventsClient is realm.AuditEvents.
type AuditEventsClient struct {
	realm *Realm
}

func newAuditEventsClient(r *Realm) *AuditEventsClient { return &AuditEventsClient{realm: r} }

// ListAuditEventsParams carries the filters for AuditEventsClient.List.
// PlatformID is intentionally not exposed — it is always the realm the
// SDK is authenticated for.
type ListAuditEventsParams struct {
	TenantID string
	ActorID  string
	Kind     []string
	Since    int64 // unix seconds; 0 → omit
	Until    int64
	Cursor   string
	Limit    int
}

// AuditEventsResponse is the GET /platforms/{id}/audit-events envelope.
// Identical to AdminEventsResponse but typed separately so the partner
// surface can evolve independently of the internal-ops feed.
type AuditEventsResponse struct {
	Items      []AuditEvent `json:"items"`
	NextCursor *string      `json:"next_cursor"`
}

// List fetches one page of audit events for the realm/platform the SDK is
// authenticated for. Pass NextCursor from the response back as Cursor on
// the next call until NextCursor is nil.
//
// Retention is 400 days; partners pulling for long-term compliance
// archives should pull at least quarterly. The cursor is opaque — do not
// parse it as a timestamp.
func (c *AuditEventsClient) List(ctx ctxpkg.Context, p ListAuditEventsParams) (*AuditEventsResponse, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	q := map[string]string{}
	if p.TenantID != "" {
		q["tenant_id"] = p.TenantID
	}
	if p.ActorID != "" {
		q["actor_id"] = p.ActorID
	}
	if len(p.Kind) > 0 {
		q["kind"] = strings.Join(p.Kind, ",")
	}
	if p.Since > 0 {
		q["since"] = strconv.FormatInt(p.Since, 10)
	}
	if p.Until > 0 {
		q["until"] = strconv.FormatInt(p.Until, 10)
	}
	if p.Cursor != "" {
		q["cursor"] = p.Cursor
	}
	if p.Limit > 0 {
		q["limit"] = strconv.Itoa(p.Limit)
	}
	var out AuditEventsResponse
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "GET",
		Path:   "/platforms/" + c.realm.realmID + "/audit-events",
		Bearer: tok,
		Query:  q,
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
