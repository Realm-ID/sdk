package realmid

import (
	"context"
	"sync"
	"time"
)

// RealmInfo is realm metadata returned by realm.Info(). Audience is the
// canonical aud value for this realm — used for verifier auto-discovery
// (SPEC §1) and as the default Origin on auth calls.
type RealmInfo struct {
	ID          string `json:"id"`
	Audience    string `json:"audience,omitempty"`
	Domain      string `json:"domain,omitempty"`
	DisplayName string `json:"display_name,omitempty"`
	// OriginEnforcement is the realm's browser-Origin policy (ADR-065),
	// read by Middleware in OriginEnforcementAuto mode. "" / "off" = no
	// check; "required" = validate Origin against the realm allowlist on
	// the unauth /auth/* routes.
	OriginEnforcement string         `json:"origin_enforcement,omitempty"`
	Extra             map[string]any `json:"-"`
}

// infoRetryWindow is the minimum gap between two FAILED discovery attempts.
const infoRetryWindow = 30 * time.Second

// infoClient implements realm.Info(). A successful result is cached for the
// life of the handle; a failed discovery is never cached, and is retried at
// most once per infoRetryWindow so an outage does not hammer the issuer.
type infoClient struct {
	realm *Realm

	mu        sync.Mutex
	cached    *RealmInfo
	failed    bool
	failedAt  time.Time
	failedErr error // nil when the response simply did not contain the realm
}

// Info returns cached realm metadata. Discovers via GET /platforms/mine
// (an API-key-scoped endpoint that lists the platforms / realms the
// caller's key belongs to) and picks out the matching realm.
func (c *infoClient) Info(ctx context.Context) (*RealmInfo, error) {
	c.mu.Lock()
	if c.cached != nil {
		cached := c.cached
		c.mu.Unlock()
		return cached, nil
	}
	if c.failed && c.realm.clock().Sub(c.failedAt) < infoRetryWindow {
		err := c.failedErr
		c.mu.Unlock()
		if err != nil {
			return nil, err
		}
		return &RealmInfo{ID: c.realm.realmID}, nil
	}
	c.mu.Unlock()

	found, err := c.discover(ctx)
	c.mu.Lock()
	defer c.mu.Unlock()
	if err != nil || found == nil {
		c.failed, c.failedAt, c.failedErr = true, c.realm.clock(), err
		if err != nil {
			return nil, err
		}
		// Stub so callers without platform metadata still get the id; not cached.
		return &RealmInfo{ID: c.realm.realmID}, nil
	}
	c.cached, c.failed, c.failedErr = found, false, nil
	return found, nil
}

func (c *infoClient) discover(ctx context.Context) (*RealmInfo, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var raw any
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "GET",
		Path:   "/platforms/mine",
		Bearer: tok,
	}, &raw); err != nil {
		return nil, err
	}
	return findRealmIn(raw, c.realm.realmID), nil
}

// invalidate clears the cached info and any failure memory; useful after a
// config update.
func (c *infoClient) invalidate() {
	c.mu.Lock()
	c.cached, c.failed, c.failedErr = nil, false, nil
	c.mu.Unlock()
}

// findRealmIn walks the GET /platforms/mine response (which can be a
// flat array, an object, or nested) looking for a realm with the given
// id and returns its RealmInfo.
func findRealmIn(node any, realmID string) *RealmInfo {
	switch v := node.(type) {
	case map[string]any:
		if id, ok := v["id"].(string); ok && id == realmID {
			aud, _ := v["audience"].(string)
			if aud == "" {
				aud, _ = v["domain"].(string)
			}
			if aud != "" || hasAnyDomainHint(v) {
				ri := &RealmInfo{ID: id, Audience: aud}
				if d, ok := v["domain"].(string); ok {
					ri.Domain = d
				}
				if dn, ok := v["display_name"].(string); ok {
					ri.DisplayName = dn
				}
				if oe, ok := v["origin_enforcement"].(string); ok {
					ri.OriginEnforcement = oe
				}
				return ri
			}
		}
		for _, child := range v {
			if r := findRealmIn(child, realmID); r != nil {
				return r
			}
		}
	case []any:
		for _, child := range v {
			if r := findRealmIn(child, realmID); r != nil {
				return r
			}
		}
	}
	return nil
}

func hasAnyDomainHint(m map[string]any) bool {
	if _, ok := m["audience"].(string); ok {
		return true
	}
	if _, ok := m["domain"].(string); ok {
		return true
	}
	return false
}
