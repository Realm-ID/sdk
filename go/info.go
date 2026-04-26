package realmid

import (
	"context"
	"sync"
)

// RealmInfo is realm metadata returned by realm.Info(). Audience is the
// canonical aud value for this realm — used for verifier auto-discovery
// (SPEC §1) and as the default Origin on auth calls.
type RealmInfo struct {
	ID          string         `json:"id"`
	Audience    string         `json:"audience,omitempty"`
	Domain      string         `json:"domain,omitempty"`
	DisplayName string         `json:"display_name,omitempty"`
	Extra       map[string]any `json:"-"`
}

// infoClient implements realm.Info() with per-handle caching.
type infoClient struct {
	realm *Realm

	mu     sync.Mutex
	cached *RealmInfo
}

// Info returns cached realm metadata. Discovers via GET /platforms/mine
// (an API-key-scoped endpoint that lists the platforms / realms the
// caller's key belongs to) and picks out the matching realm.
func (c *infoClient) Info(ctx context.Context) (*RealmInfo, error) {
	c.mu.Lock()
	cached := c.cached
	c.mu.Unlock()
	if cached != nil {
		return cached, nil
	}

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

	found := findRealmIn(raw, c.realm.realmID)
	if found == nil {
		// Fallback stub so callers without platform metadata still get the id.
		found = &RealmInfo{ID: c.realm.realmID}
	}

	c.mu.Lock()
	c.cached = found
	c.mu.Unlock()
	return found, nil
}

// invalidate clears the cached info; useful after a config update.
func (c *infoClient) invalidate() {
	c.mu.Lock()
	c.cached = nil
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
