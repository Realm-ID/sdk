package realmid

import (
	ctxpkg "context"
	"encoding/base64"
	"encoding/json"
	"errors"
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
//  1. First call: POST /auth/login {grant_type:"platform_api_key", api_key}
//     → {refresh_token, access_token, expires_in}.
//  2. When the cached access token is within 30s of expiry (or after a
//     401 invalidate): POST /auth/token with the refresh token as the
//     Authorization Bearer → {refresh_token, access_token, expires_in}.
//     Whether refresh rotates is decided server-side via the realm's
//     `platform_refresh_rotates` config (defaults to off; the response's
//     refresh_token will be the same token the SDK sent).
//  3. If /auth/token fails with 401 (or refresh is missing), we fall
//     back to step 1.
//
// The raw API key thus only ever travels on the initial /auth/login call.
type sessionManager struct {
	cred    CredentialSource
	realmID string
	http    *httpClient
	logger  *slog.Logger
	now     func() time.Time

	mu              sync.RWMutex
	refreshToken    string
	accessToken     string
	accessExpiresAt time.Time
	// inflight dedups concurrent acquisitions. When set, a refresh/login
	// is already running; other callers wait on it rather than firing a
	// second /auth/token with the same (one-time-use) refresh token, which
	// would trip the issuer's reuse-detection and kill the session.
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
	Status       string `json:"status"`
	SubjectType  string `json:"subject_type"`
	RefreshToken string `json:"refresh_token"`
	AccessToken  string `json:"access_token"`
	ExpiresIn    int    `json:"expires_in"`
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

// acquire mints or refreshes the access token, deduping concurrent
// callers so only one /auth/token (or /auth/login) request is in flight
// at a time. Without this, two goroutines that both observe a stale
// access token would each POST the same refresh token; the issuer rotates
// it on the first and rejects the second as reuse, killing the session.
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
	refresh := m.refreshToken
	m.mu.Unlock()

	tok, err := m.fetch(ctx, refresh)

	m.mu.Lock()
	m.inflight = nil
	m.mu.Unlock()
	call.token, call.err = tok, err
	close(call.done)
	return tok, err
}

// fetch performs the actual refresh-then-login acquisition. Only ever
// called by the single-flight leader in acquire.
func (m *sessionManager) fetch(ctx ctxpkg.Context, refresh string) (string, error) {
	if refresh != "" {
		tok, err := m.refreshAccess(ctx, refresh)
		if err == nil {
			return tok, nil
		}
		// 401 on /auth/token → refresh was revoked or rotated; fall back
		// to a full login. Other errors (network, 5xx) bubble up.
		var rerr *RealmError
		if !errors.As(err, &rerr) || rerr.Code != ErrCodeUnauthorized {
			return "", err
		}
		m.logger.Info("realmid session: refresh rejected, re-logging in",
			slog.String("realm_id", m.realmID),
		)
	}
	return m.login(ctx)
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
	if resp.AccessToken == "" || resp.RefreshToken == "" {
		return "", &RealmError{Code: ErrCodeServerError, Message: "platform login returned empty tokens"}
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

// refreshAccess mints a new access token (and possibly rotates the
// refresh token) via POST /auth/token. The realm's
// `platform_refresh_rotates` config decides whether refresh actually
// rotates; either way we store whatever the server returned.
func (m *sessionManager) refreshAccess(ctx ctxpkg.Context, refresh string) (string, error) {
	m.logger.Debug("realmid session: refreshing platform access",
		slog.String("realm_id", m.realmID),
	)
	var resp loginResponse
	err := m.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/auth/token",
		Bearer: refresh,
		Body:   map[string]any{},
	}, &resp)
	if err != nil {
		return "", err
	}
	if resp.AccessToken == "" {
		return "", &RealmError{Code: ErrCodeServerError, Message: "/auth/token returned empty access token"}
	}
	if err := m.checkIssuer(resp.AccessToken); err != nil {
		return "", err
	}
	// If the realm has rotation off, the server returns the same refresh
	// we sent; if rotation is on, a new refresh. Either way: store it.
	if resp.RefreshToken == "" {
		resp.RefreshToken = refresh
	}
	m.store(resp)
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
	m.refreshToken = resp.RefreshToken
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
