package realmid

import (
	ctxpkg "context"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

// sessionPeek is the unverified view of an access token that the §6.7 session
// checks need. Signature verification stays the verifier's job.
type sessionPeek struct {
	Key string // `sid`, else `jti`, else "" (SPEC §6.7.1)
	Sub string
	Iss string
	IAT int64 // 0 = absent or non-numeric
	Exp time.Time
}

func strClaim(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

func numClaim(m map[string]any, k string) int64 {
	f, ok := m[k].(float64)
	if !ok || f <= 0 {
		return 0
	}
	return int64(f)
}

// peekSession decodes the JWT payload without a signature check.
func peekSession(jwt string) (sessionPeek, error) {
	parts := strings.Split(jwt, ".")
	if len(parts) != 3 {
		return sessionPeek{}, &RealmError{Code: ErrCodeBadRequest, Message: "jwt: expected 3 parts"}
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return sessionPeek{}, &RealmError{Code: ErrCodeBadRequest, Message: "jwt: payload not base64url"}
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return sessionPeek{}, &RealmError{Code: ErrCodeBadRequest, Message: "jwt: payload not json"}
	}
	p := sessionPeek{Sub: strClaim(m, "sub"), Iss: strClaim(m, "iss"), IAT: numClaim(m, "iat")}
	if p.Key = strClaim(m, "sid"); p.Key == "" {
		p.Key = strClaim(m, "jti")
	}
	if e := numClaim(m, "exp"); e > 0 {
		p.Exp = time.Unix(e, 0)
	}
	return p, nil
}

// orgModeCache resolves a realm's org-session mode from its discovery
// document (SPEC §6.7.3): per-realm, 10-minute TTL, fail-soft to concurrent.
type orgModeCache struct {
	r  *Realm
	mu sync.Mutex
	m  map[string]modeEntry
}

type modeEntry struct {
	mode      string
	fetchedAt time.Time
}

func newOrgModeCache(r *Realm) *orgModeCache {
	return &orgModeCache{r: r, m: map[string]modeEntry{}}
}

func (c *orgModeCache) now() time.Time {
	if c.r.cfg.Clock != nil {
		return c.r.cfg.Clock()
	}
	return time.Now()
}

// mode returns "concurrent" or "exclusive" for the realm the issuer URL names.
func (c *orgModeCache) mode(ctx ctxpkg.Context, iss string) string {
	realmID, rerr := extractRealmID(iss)
	if rerr != nil {
		return OrgSessionsConcurrent
	}
	c.mu.Lock()
	if e, ok := c.m[realmID]; ok && c.now().Sub(e.fetchedAt) < jwksTTL {
		c.mu.Unlock()
		return e.mode
	}
	c.mu.Unlock()
	mode := c.fetch(ctx, realmID)
	c.mu.Lock()
	c.m[realmID] = modeEntry{mode: mode, fetchedAt: c.now()}
	c.mu.Unlock()
	return mode
}

func (c *orgModeCache) fetch(ctx ctxpkg.Context, realmID string) string {
	url := strings.TrimRight(c.r.baseURL, "/") + "/" + realmID + "/.well-known/openid-configuration"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return OrgSessionsConcurrent
	}
	resp, err := c.r.http.hc.Do(req)
	if err != nil {
		c.r.logger.Warn("realmid: org-session mode fetch failed; using concurrent", slog.Any("error", err))
		return OrgSessionsConcurrent
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		c.r.logger.Warn("realmid: org-session mode fetch failed; using concurrent", slog.Int("status", resp.StatusCode))
		return OrgSessionsConcurrent
	}
	var doc struct {
		Mode string `json:"realmid_org_sessions"`
	}
	if json.NewDecoder(resp.Body).Decode(&doc) != nil || doc.Mode != OrgSessionsExclusive {
		return OrgSessionsConcurrent
	}
	return OrgSessionsExclusive
}
