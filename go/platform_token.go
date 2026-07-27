package realmid

import (
	ctxpkg "context"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"time"
)

// sessionManager implements ADR-051's two-endpoint auth surface for the
// SDK's platform identity.
//
// On every call that needs platform-bearer auth, the manager either
// returns a cached access token or mints/refreshes one. The lifecycle is:
//
//  1. POST /auth/login {grant_type:"platform_api_key", api_key} (or the
//     token-exchange grant) → {access_token, expires_in}.
//  2. When the cached access token is within 30s of expiry (or after a
//     401 invalidate): do exactly the same thing again.
//
// There is no refresh step. ADR-089 (issuer v0.68.0) withdrew the refresh
// token from every credential-bootstrapped session: the caller is holding the
// api key / can mint a fresh workload assertion at the moment it needs a token,
// so a refresh token was a strictly weaker duplicate of a credential it already
// had — and one that outlived revocation of its source. Re-minting costs the
// same single round trip the refresh did.
//
// The bootstrap credential therefore travels on every acquisition (roughly once
// per access-token lifetime, 5 min by default), not just the first.
type sessionManager struct {
	cred    CredentialSource
	realmID string
	http    *httpClient
	logger  *slog.Logger
	now     func() time.Time

	mu              sync.RWMutex
	accessToken     string
	accessExpiresAt time.Time
	// inflight dedups concurrent acquisitions. When set, a login is already
	// running; other callers wait on it rather than each firing their own,
	// which would stampede /auth/login on every token expiry.
	inflight *tokenCall
}

// tokenCall is a single in-flight token acquisition shared by all callers
// that arrive while it runs. The leader closes done after storing the
// result; followers read token/err once done is closed.
type tokenCall struct {
	done  chan struct{}
	token string
	err   error
}

func newSessionManager(cred CredentialSource, realmID string, http *httpClient, logger *slog.Logger, now func() time.Time) *sessionManager {
	if now == nil {
		now = time.Now
	}
	return &sessionManager{
		cred:    cred,
		realmID: realmID,
		http:    http,
		logger:  logger,
		now:     now,
	}
}

// loginResponse is the wire shape returned by POST /auth/login for the
// platform_api_key grant (and used by /auth/token for service/platform).
type loginResponse struct {
	Status      string `json:"status"`
	SubjectType string `json:"subject_type"`
	AccessToken string `json:"access_token"`
	ExpiresIn   int    `json:"expires_in"`
	// No RefreshToken: ADR-089 stopped issuing one for this grant.
}

// get returns a fresh access token, minting/refreshing one as needed.
// Same surface the previous platformTokenManager exposed — every call
// site (config.go, roles.go, origins.go, ...) uses this as their Bearer.
func (m *sessionManager) get(ctx ctxpkg.Context) (string, error) {
	m.mu.RLock()
	access := m.accessToken
	exp := m.accessExpiresAt
	m.mu.RUnlock()
	if access != "" && exp.Sub(m.now()) >= 30*time.Second {
		return access, nil
	}
	return m.acquire(ctx)
}

// acquire mints the access token, deduping concurrent callers so only one
// /auth/login request is in flight at a time. Without this, every goroutine
// that observed the stale token would mint its own session row.
func (m *sessionManager) acquire(ctx ctxpkg.Context) (string, error) {
	m.mu.Lock()
	// Re-check under the write lock: a peer may have refreshed while we
	// waited for the lock, in which case the cached token is now fresh.
	if m.accessToken != "" && m.accessExpiresAt.Sub(m.now()) >= 30*time.Second {
		tok := m.accessToken
		m.mu.Unlock()
		return tok, nil
	}
	// Join an in-flight acquisition rather than starting a second one.
	if call := m.inflight; call != nil {
		m.mu.Unlock()
		<-call.done
		return call.token, call.err
	}
	call := &tokenCall{done: make(chan struct{})}
	m.inflight = call
	m.mu.Unlock()

	tok, err := m.login(ctx)

	m.mu.Lock()
	m.inflight = nil
	m.mu.Unlock()
	call.token, call.err = tok, err
	close(call.done)
	return tok, err
}

// login exchanges the bootstrap credential (a static API key or an ambient
// workload OIDC token) for a refresh + access token via POST /auth/login.
// The credential never travels on subsequent traffic — only here.
func (m *sessionManager) login(ctx ctxpkg.Context) (string, error) {
	cred, err := m.cred.Fetch(ctx)
	if err != nil {
		return "", err
	}
	body := map[string]any{"grant_type": cred.GrantType}
	var redacted string
	switch cred.GrantType {
	case grantPlatformAPIKey:
		if cred.APIKey == "" {
			return "", &RealmError{Code: ErrCodeUnauthorized, Message: "credential source returned an empty API key"}
		}
		body["api_key"] = cred.APIKey
		redacted = redactCredential(cred.APIKey)
	case grantTokenExchange:
		if cred.SubjectToken == "" {
			return "", &RealmError{Code: ErrCodeUnauthorized, Message: "credential source returned an empty workload token"}
		}
		body["subject_token"] = cred.SubjectToken
		body["subject_token_type"] = subjectTokenTypeJWT
		redacted = redactCredential(cred.SubjectToken)
	default:
		return "", &RealmError{Code: ErrCodeBadRequest, Message: "unsupported credential grant_type: " + cred.GrantType}
	}
	m.logger.Info("realmid session: platform login",
		slog.String("realm_id", m.realmID),
		slog.String("grant_type", cred.GrantType),
		slog.String("credential", redacted),
	)

	var resp loginResponse
	err = m.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/auth/login",
		Body:   body,
	}, &resp)
	if err != nil {
		return "", err
	}
	// ADR-089: a platform login returns NO refresh_token. Requiring one here
	// is what made an older SDK fail hard — not degrade — against an issuer on
	// v0.68.0 or later.
	if resp.AccessToken == "" {
		return "", &RealmError{Code: ErrCodeServerError, Message: "platform login returned an empty access token"}
	}
	if err := m.checkIssuer(resp.AccessToken); err != nil {
		return "", err
	}
	m.store(resp)
	m.logger.Info("realmid session: platform login complete",
		slog.String("realm_id", m.realmID),
		slog.Time("expires_at", m.accessExpiresAt),
		slog.String("access_token", redactCredential(resp.AccessToken)),
	)
	return resp.AccessToken, nil
}

// checkIssuer is the ADR-041 client-side realm pin: decode the JWT
// (no signature check — we just got it from RI over TLS) and confirm
// its iss claim references the configured realm. Catches confused-deputy
// bugs where the SDK was constructed with realm A but the API key
// actually belongs to realm B.
func (m *sessionManager) checkIssuer(jwt string) error {
	iss, perr := peekJWTIssuer(jwt)
	if perr != nil {
		return nil // malformed payload — let the verifier surface it later
	}
	if !strings.HasSuffix(iss, "/"+m.realmID) {
		return &RealmError{
			Code:    ErrCodeRealmMismatch,
			Message: "platform access token's iss does not match configured realm: got " + iss + ", configured realm " + m.realmID,
		}
	}
	return nil
}

func (m *sessionManager) store(resp loginResponse) {
	exp := m.now().Add(time.Duration(resp.ExpiresIn) * time.Second)
	if resp.ExpiresIn == 0 {
		exp = m.now().Add(5 * time.Minute) // SPEC §4.0 default
	}
	m.mu.Lock()
	m.accessToken = resp.AccessToken
	m.accessExpiresAt = exp
	m.mu.Unlock()
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

// peekJWTUserFields decodes the JWT payload (no signature check) and
// returns its `sub`, `email`, and `name` claims. Used by Auth.Login to
// backfill UserSummary fields the wire response shape omits today.
// Signature verification stays the verifier's job.
func peekJWTUserFields(jwt string) (sub, email, name string, err error) {
	parts := strings.Split(jwt, ".")
	if len(parts) != 3 {
		return "", "", "", &RealmError{Code: ErrCodeBadRequest, Message: "jwt: expected 3 parts"}
	}
	raw, derr := base64.RawURLEncoding.DecodeString(parts[1])
	if derr != nil {
		return "", "", "", &RealmError{Code: ErrCodeBadRequest, Message: "jwt: payload not base64url"}
	}
	var c struct {
		Sub   string `json:"sub"`
		Email string `json:"email"`
		Name  string `json:"name"`
	}
	if jerr := json.Unmarshal(raw, &c); jerr != nil {
		return "", "", "", &RealmError{Code: ErrCodeBadRequest, Message: "jwt: payload not json"}
	}
	return c.Sub, c.Email, c.Name, nil
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

// invalidate clears the cached access token. Used after an auth failure
// to force a re-mint on the next call. The refresh token is preserved
// so the next get() can attempt /auth/token before a full re-login.
func (m *sessionManager) invalidate() {
	m.mu.Lock()
	m.accessToken = ""
	m.accessExpiresAt = time.Time{}
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
	Revoke(ctx ctxpkg.Context, jti string, expiresAt time.Time) error
	// IsRevoked returns true when jti has been revoked and the TTL has
	// not elapsed. Errors propagate to the verifier which fails closed
	// (request rejected).
	IsRevoked(ctx ctxpkg.Context, jti string) (bool, error)
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
func (m *MemRevocationCache) Revoke(_ ctxpkg.Context, jti string, expiresAt time.Time) error {
	if jti == "" {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.entries[jti] = expiresAt
	return nil
}

// IsRevoked implements RevocationCache.
func (m *MemRevocationCache) IsRevoked(_ ctxpkg.Context, jti string) (bool, error) {
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
