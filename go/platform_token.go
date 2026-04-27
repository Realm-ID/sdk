package realmid

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"time"
)

// platformTokenManager implements SPEC §4.0 dual-token login.
//
// On every call that needs platform-bearer auth, the manager either
// returns a cached token or mints a fresh one against
// POST /auth/platform-token with the raw API key. Refresh fires when
// fewer than 30s remain on the cached token's expiry.
type platformTokenManager struct {
	apiKey  string
	realmID string
	http    *httpClient
	logger  *slog.Logger
	now     func() time.Time

	mu        sync.RWMutex
	token     string
	expiresAt time.Time
}

func newPlatformTokenManager(apiKey, realmID string, http *httpClient, logger *slog.Logger, now func() time.Time) *platformTokenManager {
	if now == nil {
		now = time.Now
	}
	return &platformTokenManager{
		apiKey:  apiKey,
		realmID: realmID,
		http:    http,
		logger:  logger,
		now:     now,
	}
}

// platformTokenResponse is the wire shape returned by /auth/platform-token.
type platformTokenResponse struct {
	PlatformToken string `json:"platform_token"`
	ExpiresIn     int    `json:"expires_in"`
	ExpiresAt     string `json:"expires_at,omitempty"`
}

// get returns a fresh platform token, minting one if the cache is empty
// or within the 30s pre-expiry window.
func (m *platformTokenManager) get(ctx context.Context) (string, error) {
	m.mu.RLock()
	tok := m.token
	exp := m.expiresAt
	m.mu.RUnlock()
	if tok != "" && exp.Sub(m.now()) >= 30*time.Second {
		return tok, nil
	}
	return m.refresh(ctx)
}

// refresh forces a re-mint regardless of cache state.
func (m *platformTokenManager) refresh(ctx context.Context) (string, error) {
	if m.apiKey == "" {
		return "", &RealmError{Code: ErrCodeUnauthorized, Message: "no API key configured for platform token mint"}
	}
	m.logger.Info("realmid platform token mint",
		slog.String("realm_id", m.realmID),
		slog.String("api_key", redactCredential(m.apiKey)),
	)

	var resp platformTokenResponse
	err := m.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/auth/platform-token",
		Bearer: m.apiKey,
		Body:   map[string]any{"realm_id": m.realmID},
	}, &resp)
	if err != nil {
		return "", err
	}
	if resp.PlatformToken == "" {
		return "", &RealmError{Code: ErrCodeServerError, Message: "platform token mint returned empty token"}
	}

	// ADR-041: client-side realm pinning. Decode the minted JWT (no
	// signature check — we just got it from RI over TLS) and confirm its
	// iss claim references the configured realm. Catches confused-deputy
	// bugs where the SDK was constructed with realm A but the API key
	// actually belongs to realm B; the bug would otherwise surface much
	// later as cryptic 4xx on partner-level operations.
	if iss, perr := peekJWTIssuer(resp.PlatformToken); perr == nil {
		if !strings.HasSuffix(iss, "/"+m.realmID) {
			return "", &RealmError{
				Code:    ErrCodeUnauthorized,
				Message: "platform token's iss does not match configured realm: got " + iss + ", configured realm " + m.realmID,
			}
		}
	}

	exp := m.now().Add(time.Duration(resp.ExpiresIn) * time.Second)
	if resp.ExpiresIn == 0 {
		exp = m.now().Add(5 * time.Minute) // SPEC §4.0 default
	}

	m.mu.Lock()
	m.token = resp.PlatformToken
	m.expiresAt = exp
	m.mu.Unlock()

	m.logger.Info("realmid platform token refreshed",
		slog.String("realm_id", m.realmID),
		slog.Time("expires_at", exp),
		slog.String("token", redactCredential(resp.PlatformToken)),
	)
	return resp.PlatformToken, nil
}

// peekJWTIssuer decodes the JWT payload (no signature check) and returns
// its `iss` claim. Returns "" + error on malformed input. Used by the
// realm-pinning check; signature verification stays the verifier's job.
func peekJWTIssuer(jwt string) (string, error) {
	parts := strings.Split(jwt, ".")
	if len(parts) != 3 {
		return "", &RealmError{Code: ErrCodeBadRequest, Message: "jwt: expected 3 parts"}
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", &RealmError{Code: ErrCodeBadRequest, Message: "jwt: payload not base64url"}
	}
	var c struct {
		Iss string `json:"iss"`
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return "", &RealmError{Code: ErrCodeBadRequest, Message: "jwt: payload not json"}
	}
	return c.Iss, nil
}

// peekJWTRevokeFields decodes the JWT payload (no signature check) and
// returns its `jti` and `exp` claims. Used by AuthClient.Logout's
// RevocationCache integration. Returns ("", zero time, error) on
// malformed input. Signature verification stays the verifier's job.
func peekJWTRevokeFields(jwt string) (string, time.Time, error) {
	parts := strings.Split(jwt, ".")
	if len(parts) != 3 {
		return "", time.Time{}, &RealmError{Code: ErrCodeBadRequest, Message: "jwt: expected 3 parts"}
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", time.Time{}, &RealmError{Code: ErrCodeBadRequest, Message: "jwt: payload not base64url"}
	}
	var c struct {
		JTI string `json:"jti"`
		Exp int64  `json:"exp"`
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return "", time.Time{}, &RealmError{Code: ErrCodeBadRequest, Message: "jwt: payload not json"}
	}
	exp := time.Time{}
	if c.Exp > 0 {
		exp = time.Unix(c.Exp, 0)
	}
	return c.JTI, exp, nil
}

// invalidate clears the cached token. Used after an auth failure to
// force a remint on the next call.
func (m *platformTokenManager) invalidate() {
	m.mu.Lock()
	m.token = ""
	m.expiresAt = time.Time{}
	m.mu.Unlock()
}

// ---- Shared revocation cache (ADR-041 follow-up) ----
//
// RealmID's refresh-token revocation is server-tracked and instant. But
// access tokens are stateless RS256 JWTs — once minted, they verify on
// signature + exp alone until they naturally expire (default 15min).
//
// Partners that want stop-the-bleed semantics on stolen access tokens
// between "user clicks logout" and "JWT naturally expires" can wire a
// shared RevocationCache. The verifier checks it after signature verify;
// cache hit on the JWT's jti → reject as revoked.
//
// Pluggable: in-process LRU shipped as default; partners running multi-
// instance backends supply Redis/memcached/etc. OPT-IN: nil by default;
// verify() and Logout() behave as before when not configured.

// RevocationCache is the partner-pluggable JTI denylist. Cheap reads
// matter — IsRevoked is on the hot path of every authenticated request.
type RevocationCache interface {
	// Revoke marks jti as revoked. expiresAt is the JWT's exp, used as
	// the cache entry TTL — partners' implementations should evict on
	// expiry so the cache never grows unboundedly.
	Revoke(ctx context.Context, jti string, expiresAt time.Time) error
	// IsRevoked returns true when jti has been revoked and the TTL has
	// not elapsed. Errors propagate to the verifier which fails closed
	// (request rejected).
	IsRevoked(ctx context.Context, jti string) (bool, error)
}

// MemRevocationCache is a single-process implementation suitable for a
// single partner-API replica or for tests. Multi-replica deployments
// should wire a shared backend (Redis, etc.) by implementing the
// RevocationCache interface directly. Lazily evicts expired entries.
type MemRevocationCache struct {
	mu      sync.RWMutex
	entries map[string]time.Time
	now     func() time.Time
}

// NewMemRevocationCache returns an empty MemRevocationCache. now is the
// clock; pass nil to default to time.Now.
func NewMemRevocationCache(now func() time.Time) *MemRevocationCache {
	if now == nil {
		now = time.Now
	}
	return &MemRevocationCache{entries: map[string]time.Time{}, now: now}
}

// Revoke implements RevocationCache.
func (m *MemRevocationCache) Revoke(_ context.Context, jti string, expiresAt time.Time) error {
	if jti == "" {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.entries[jti] = expiresAt
	return nil
}

// IsRevoked implements RevocationCache.
func (m *MemRevocationCache) IsRevoked(_ context.Context, jti string) (bool, error) {
	if jti == "" {
		return false, nil
	}
	m.mu.RLock()
	exp, ok := m.entries[jti]
	m.mu.RUnlock()
	if !ok {
		return false, nil
	}
	if !exp.IsZero() && m.now().After(exp) {
		m.mu.Lock()
		delete(m.entries, jti)
		m.mu.Unlock()
		return false, nil
	}
	return true, nil
}

// Len returns the current entry count. Useful for tests + instrumentation.
func (m *MemRevocationCache) Len() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.entries)
}
