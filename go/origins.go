package realmid

import (
	ctxpkg "context"
	"strings"
	"sync"
	"time"
)

// Origin is one row in the per-realm origin allowlist (ADR-049 §A.7.2).
// Every listed row is live: the issuer's GET /platforms/{id}/origins filters
// detached rows server-side (detached_at IS NULL) and never serializes a
// detached_at field, so a returned row means the bare hostname routes to the
// referenced realm or tenant entity — and, by extension, is permitted to make
// unauthenticated proxy calls to the partner backend that fronts
// platform-token-gated RealmID routes.
type Origin struct {
	ID             string  `json:"id"`
	Domain         string  `json:"domain"`
	EntityType     string  `json:"entity_type"`
	EntityID       string  `json:"entity_id"`
	VerificationID *string `json:"verification_id,omitempty"`
	// CreatedAt is unix seconds. The issuer serializes every list/get
	// created_at as a JSON number (toDomainDTO → CreatedAt.Unix()); this was
	// mistyped as string through go/v0.21.0, which made the strict decode of
	// the origin allowlist throw on the BFF login hot path. Fixed in v0.22.0.
	CreatedAt int64 `json:"created_at,omitempty"`
}

// ListOriginsOptions parameterises Origins.List.
type ListOriginsOptions struct {
	RealmID string
	Cursor  string
	Limit   int
}

// ValidateOriginOptions parameterises Origins.Validate.
type ValidateOriginOptions struct {
	RealmID string
	Origin  string
}

// OriginsClient implements ADR-047 §1.1 — partner-side origin allowlist
// enforcement. Concurrent-safe.
type OriginsClient struct {
	realm *Realm
	now   func() time.Time

	mu    sync.RWMutex
	cache map[string]*originsCacheEntry
}

type originsCacheEntry struct {
	allowlist map[string]struct{}
	fetchedAt time.Time
}

// originsCacheTTL is the per-realm cache TTL (ADR-047 §1.1).
const originsCacheTTL = 5 * time.Minute

func newOriginsClient(r *Realm) *OriginsClient {
	now := time.Now
	if r != nil && r.cfg.Clock != nil {
		now = r.cfg.Clock
	}
	return &OriginsClient{
		realm: r,
		now:   now,
		cache: map[string]*originsCacheEntry{},
	}
}

// NormalizeOrigin lowercases an origin and strips scheme + port + path
// to a bare hostname. Mirrors `domainmapping.Normalize` server-side.
func NormalizeOrigin(raw string) string {
	if raw == "" {
		return ""
	}
	s := strings.ToLower(strings.TrimSpace(raw))
	if strings.HasPrefix(s, "https://") {
		s = s[len("https://"):]
	} else if strings.HasPrefix(s, "http://") {
		s = s[len("http://"):]
	}
	if i := strings.IndexByte(s, '/'); i >= 0 {
		s = s[:i]
	}
	if i := strings.IndexByte(s, ':'); i >= 0 {
		s = s[:i]
	}
	return s
}

// List returns a paginated iterator over the realm's live origin
// mappings. Wraps GET /platforms/{realmId}/origins (ADR-049 §A.7.2).
func (c *OriginsClient) List(_ ctxpkg.Context, opts ListOriginsOptions) (*Paginated[Origin], error) {
	if opts.RealmID == "" {
		return nil, &RealmError{Code: ErrCodeBadRequest, Message: "origins.List: RealmID required"}
	}
	realmID := opts.RealmID
	return newPaginated[Origin](func(ctx ctxpkg.Context, po PageOpts) (*Page[Origin], error) {
		return c.fetchPage(ctx, realmID, po)
	}), nil
}

// Validate reports whether the inbound origin is on the realm's
// allowlist. The cached allowlist is refreshed on cache miss + TTL
// expiry. On a 401 from the underlying list call, the platform token
// is invalidated and the call is retried once.
func (c *OriginsClient) Validate(ctx ctxpkg.Context, opts ValidateOriginOptions) (bool, error) {
	if opts.RealmID == "" {
		return false, &RealmError{Code: ErrCodeBadRequest, Message: "origins.Validate: RealmID required"}
	}
	norm := NormalizeOrigin(opts.Origin)
	if norm == "" {
		return false, nil
	}
	allow, err := c.allowlistFor(ctx, opts.RealmID)
	if err != nil {
		return false, err
	}
	_, ok := allow[norm]
	return ok, nil
}

// Invalidate drops the cached allowlist for one realm (or all if "").
func (c *OriginsClient) Invalidate(realmID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if realmID == "" {
		c.cache = map[string]*originsCacheEntry{}
		return
	}
	delete(c.cache, realmID)
}

func (c *OriginsClient) allowlistFor(ctx ctxpkg.Context, realmID string) (map[string]struct{}, error) {
	c.mu.RLock()
	hit, ok := c.cache[realmID]
	c.mu.RUnlock()
	if ok && c.now().Sub(hit.fetchedAt) < originsCacheTTL {
		return hit.allowlist, nil
	}
	fresh, err := c.fetchAllowlist(ctx, realmID)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	c.cache[realmID] = &originsCacheEntry{allowlist: fresh, fetchedAt: c.now()}
	c.mu.Unlock()
	return fresh, nil
}

func (c *OriginsClient) fetchAllowlist(ctx ctxpkg.Context, realmID string) (map[string]struct{}, error) {
	out := map[string]struct{}{}
	cursor := ""
	for {
		page, err := c.fetchPage(ctx, realmID, PageOpts{Cursor: cursor})
		if err != nil {
			return nil, err
		}
		for _, row := range page.Items {
			d := NormalizeOrigin(row.Domain)
			if d != "" {
				out[d] = struct{}{}
			}
		}
		if page.NextCursor == "" {
			return out, nil
		}
		cursor = page.NextCursor
	}
}

func (c *OriginsClient) fetchPage(ctx ctxpkg.Context, realmID string, po PageOpts) (*Page[Origin], error) {
	page, err := c.doListCall(ctx, realmID, po)
	if err == nil {
		return page, nil
	}
	// On 401, force a fresh platform token mint and retry once.
	if re, ok := err.(*RealmError); ok && re.Code == ErrCodeUnauthorized {
		c.realm.platformToken.invalidate()
		return c.doListCall(ctx, realmID, po)
	}
	return nil, err
}

func (c *OriginsClient) doListCall(ctx ctxpkg.Context, realmID string, po PageOpts) (*Page[Origin], error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	q := map[string]string{}
	if po.Cursor != "" {
		q["cursor"] = po.Cursor
	}
	if po.Limit > 0 {
		// best-effort string convert without strconv import explosion
		q["limit"] = itoa(po.Limit)
	}
	var env pageEnvelope[Origin]
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "GET",
		Path:   "/platforms/" + realmID + "/origins",
		Query:  q,
		Bearer: tok,
	}, &env); err != nil {
		return nil, err
	}
	return &Page[Origin]{Items: env.Items, NextCursor: env.NextCursor, Total: env.Total}, nil
}

// OriginClaim is the response from OriginsClient.Claim. Realm-origin
// claims are DNS-TXT only — the html_file method is not exposed at
// the platform surface (see ADR-049 §"Method options").
type OriginClaim struct {
	Domain         string `json:"domain"`
	Status         string `json:"status"`
	Method         string `json:"method"` // always "dns_txt"
	DNSRecordName  string `json:"dns_record_name"`
	DNSRecordValue string `json:"dns_record_value"`
}

// Claim begins a realm-owned origin claim. The DV row is owner-scoped
// to the realm — any admin in this realm can complete the verify step
// and add the bind. Re-claiming returns the existing pending token
// (idempotent).
func (c *OriginsClient) Claim(ctx ctxpkg.Context, realmID, hostname string) (*OriginClaim, error) {
	if realmID == "" || hostname == "" {
		return nil, &RealmError{Code: ErrCodeBadRequest, Message: "Origins.Claim: realmID and hostname required"}
	}
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var resp OriginClaim
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/platforms/" + realmID + "/origins/claim",
		Bearer: tok,
		Body:   map[string]string{"domain": hostname},
	}, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// Verify drives the DNS check on the realm's pending DV row. Does NOT
// bind — call Origins.Bind (POST /platforms/{id}/origins) afterwards
// so a single verified apex can serve as the trust anchor for
// trusted-by-parent subdomain origins.
func (c *OriginsClient) Verify(ctx ctxpkg.Context, realmID, hostname string) (*DomainVerifyResult, error) {
	if realmID == "" || hostname == "" {
		return nil, &RealmError{Code: ErrCodeBadRequest, Message: "Origins.Verify: realmID and hostname required"}
	}
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var resp DomainVerifyResult
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/platforms/" + realmID + "/origins/verify",
		Bearer: tok,
		Body:   map[string]string{"domain": hostname},
	}, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
