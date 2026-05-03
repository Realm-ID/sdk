// Admin aggregates surface (ADR-048, SPEC §7.5).
//
// All four endpoints are gated server-side on base-realm staff. The SDK
// does not gate locally — it forwards the platform-token bearer and
// surfaces the API's 403 envelope as RealmError(forbidden).

package realmid

import (
	ctxpkg "context"
	"strconv"
	"strings"
)

// PlatformOwner is the embedded owner block on a PlatformSummary.
type PlatformOwner struct {
	UserID string `json:"user_id"`
	Name   string `json:"name"`
	Email  string `json:"email"`
}

// PlatformSummary is one row in AdminPlatformsResponse.Items.
type PlatformSummary struct {
	ID             string        `json:"id"`
	DisplayName    string        `json:"display_name"`
	Slug           string        `json:"slug"`
	Status         string        `json:"status"`
	SignupMode     string        `json:"signup_mode"`
	Domains        []string      `json:"domains"`
	Owner          PlatformOwner `json:"owner"`
	TenantsCount   int           `json:"tenants_count"`
	UsersCount     int           `json:"users_count"`
	LastActivityAt int64         `json:"last_activity_at"`
	CreatedAt      int64         `json:"created_at"`
}

// AdminPlatformsResponse is the GET /admin/platforms envelope.
type AdminPlatformsResponse struct {
	Items      []PlatformSummary `json:"items"`
	NextCursor *string           `json:"next_cursor"`
	Total      int               `json:"total"`
}

// AdminStats is the GET /admin/stats response.
type AdminStats struct {
	PlatformsCount int `json:"platforms_count"`
	TenantsCount   int `json:"tenants_count"`
	UsersCount     int `json:"users_count"`
	SessionsActive int `json:"sessions_active"`
	Events24h      int `json:"events_24h"`
}

// AuditEvent is one row in AdminEventsResponse.Items.
type AuditEvent struct {
	ID          int64  `json:"id"`
	OccurredAt  int64  `json:"occurred_at"`
	Kind        string `json:"kind"`
	ActorUserID string `json:"actor_user_id,omitempty"`
	ActorLabel  string `json:"actor_label,omitempty"`
	PlatformID  string `json:"platform_id,omitempty"`
	TenantID    string `json:"tenant_id,omitempty"`
	TargetType  string `json:"target_type,omitempty"`
	TargetID    string `json:"target_id,omitempty"`
	Summary     string `json:"summary,omitempty"`
}

// AdminEventsResponse is the GET /admin/events envelope.
type AdminEventsResponse struct {
	Items      []AuditEvent `json:"items"`
	NextCursor *string      `json:"next_cursor"`
}

// SearchHit is one row in AdminSearchResponse.Items.
type SearchHit struct {
	Type       string `json:"type"`
	ID         string `json:"id"`
	Label      string `json:"label"`
	Sublabel   string `json:"sublabel,omitempty"`
	PlatformID string `json:"platform_id,omitempty"`
}

// AdminSearchResponse is the GET /admin/search response.
type AdminSearchResponse struct {
	Items []SearchHit `json:"items"`
}

// ListPlatformsParams carries the filter / pagination knobs for
// AdminClient.ListPlatforms (SPEC §7.5).
type ListPlatformsParams struct {
	Q                  string
	Status             []string
	SignupMode         []string
	Domain             string
	OwnerUserID        string
	HasCustomDomain    *bool
	CreatedAfter       int64 // unix seconds; 0 → omit
	CreatedBefore      int64
	LastActivityAfter  int64
	LastActivityBefore int64
	Sort               string
	Cursor             string
	Limit              int
}

// ListEventsParams carries the filters for AdminClient.ListEvents.
type ListEventsParams struct {
	PlatformID string
	TenantID   string
	ActorID    string
	Kind       []string
	Since      int64 // unix seconds; 0 → omit
	Until      int64
	Cursor     string
	Limit      int
}

// AdminClient is realm.Admin. ADR-048 / SPEC §7.5.
type AdminClient struct {
	realm *Realm
}

func newAdminClient(r *Realm) *AdminClient { return &AdminClient{realm: r} }

// ListPlatforms wraps GET /admin/platforms.
func (c *AdminClient) ListPlatforms(ctx ctxpkg.Context, p ListPlatformsParams) (*AdminPlatformsResponse, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	q := map[string]string{}
	if p.Q != "" {
		q["q"] = p.Q
	}
	if len(p.Status) > 0 {
		q["status"] = strings.Join(p.Status, ",")
	}
	if len(p.SignupMode) > 0 {
		q["signup_mode"] = strings.Join(p.SignupMode, ",")
	}
	if p.Domain != "" {
		q["domain"] = p.Domain
	}
	if p.OwnerUserID != "" {
		q["owner_user_id"] = p.OwnerUserID
	}
	if p.HasCustomDomain != nil {
		if *p.HasCustomDomain {
			q["has_custom_domain"] = "true"
		} else {
			q["has_custom_domain"] = "false"
		}
	}
	if p.CreatedAfter > 0 {
		q["created_after"] = strconv.FormatInt(p.CreatedAfter, 10)
	}
	if p.CreatedBefore > 0 {
		q["created_before"] = strconv.FormatInt(p.CreatedBefore, 10)
	}
	if p.LastActivityAfter > 0 {
		q["last_activity_after"] = strconv.FormatInt(p.LastActivityAfter, 10)
	}
	if p.LastActivityBefore > 0 {
		q["last_activity_before"] = strconv.FormatInt(p.LastActivityBefore, 10)
	}
	if p.Sort != "" {
		q["sort"] = p.Sort
	}
	if p.Cursor != "" {
		q["cursor"] = p.Cursor
	}
	if p.Limit > 0 {
		q["limit"] = strconv.Itoa(p.Limit)
	}
	var out AdminPlatformsResponse
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "GET",
		Path:   "/admin/platforms",
		Bearer: tok,
		Query:  q,
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Stats wraps GET /admin/stats.
func (c *AdminClient) Stats(ctx ctxpkg.Context) (*AdminStats, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out AdminStats
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "GET",
		Path:   "/admin/stats",
		Bearer: tok,
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListEvents wraps GET /admin/events.
func (c *AdminClient) ListEvents(ctx ctxpkg.Context, p ListEventsParams) (*AdminEventsResponse, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	q := map[string]string{}
	if p.PlatformID != "" {
		q["platform_id"] = p.PlatformID
	}
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
	var out AdminEventsResponse
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "GET",
		Path:   "/admin/events",
		Bearer: tok,
		Query:  q,
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Search wraps GET /admin/search. limit ≤ 0 omits the param (server
// default applies).
func (c *AdminClient) Search(ctx ctxpkg.Context, q string, limit int) (*AdminSearchResponse, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	qs := map[string]string{}
	if q != "" {
		qs["q"] = q
	}
	if limit > 0 {
		qs["limit"] = strconv.Itoa(limit)
	}
	var out AdminSearchResponse
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "GET",
		Path:   "/admin/search",
		Bearer: tok,
		Query:  qs,
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
