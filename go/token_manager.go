package realmid

import (
	ctxpkg "context"
	"fmt"
	"sync"
	"time"
)

// TokenManager keeps a single user/identity session's access token fresh
// for a long-lived, single-identity client — a desktop app, sync agent,
// or daemon that holds one refresh token and needs a continuously-valid
// access token without hand-rolling the refresh loop (SPEC §4.2.1).
//
// It is NOT for browser/BFF flows (use the middleware, SPEC §10) nor for
// the SDK's internal platform session (§4.0). Construct it from a refresh
// token the client already holds via realm.Auth.NewTokenManager.
//
// Rotation safety: user refresh tokens are one-time-use and rotate on
// every /auth/token (ADR-031). The manager therefore (a) single-flights
// concurrent acquisitions so two goroutines never present the same
// refresh token (which would trip reuse-detection and kill the session),
// and (b) persists the rotated token through the RefreshSink *before*
// returning the new access token, so a crash can never strand the client
// on a consumed token.
type TokenManager struct {
	auth     *AuthClient
	tenantID string
	sink     RefreshSink
	now      func() time.Time

	mu              sync.Mutex
	refreshToken    string
	accessToken     string
	accessExpiresAt time.Time
	inflight        *tokenCall
	// forcedToken is the access token the LAST forced refresh produced. It is
	// the whole of D13's bookkeeping: a token_stale on this exact token means
	// the refresh already happened and did not help, so refreshing again would
	// be the loop. One string, not a set — the cap is per token, and the only
	// token that can be "already refreshed for" is the one we just minted.
	forcedToken string
}

// RefreshSink durably persists a rotated refresh token. The manager calls
// it after each successful /auth/token and BLOCKS on it: only if it
// returns nil does the manager cache and hand back the new access token.
// A sink that returns an error fails the acquisition (the caller's
// durable store still holds the previous token). Best-effort /
// fire-and-forget sinks do NOT satisfy the crash-safety contract.
type RefreshSink func(ctx ctxpkg.Context, newRefreshToken string) error

// TokenManagerOption configures a TokenManager at construction.
type TokenManagerOption func(*TokenManager)

// WithRefreshSink registers a durable sink for rotated refresh tokens.
// See RefreshSink for the persist-before-return contract.
func WithRefreshSink(sink RefreshSink) TokenManagerOption {
	return func(m *TokenManager) { m.sink = sink }
}

// WithTokenManagerTenant pins the tenant_id sent on each /auth/token
// (required for multi-tenant user refresh tokens; ignored otherwise).
func WithTokenManagerTenant(tenantID string) TokenManagerOption {
	return func(m *TokenManager) { m.tenantID = tenantID }
}

// withTokenManagerClock overrides the clock (tests only).
func withTokenManagerClock(now func() time.Time) TokenManagerOption {
	return func(m *TokenManager) {
		if now != nil {
			m.now = now
		}
	}
}

// tokenManagerRefreshLead is how far ahead of expiry the manager proactively
// refreshes, so callers under steady load never observe an expired token.
const tokenManagerRefreshLead = 60 * time.Second

// NewTokenManager builds a TokenManager seeded with a refresh token the
// client already holds (obtained out-of-band, e.g. at enrollment). The
// manager refreshes against POST /auth/token directly on that token.
func (a *AuthClient) NewTokenManager(refreshToken string, opts ...TokenManagerOption) *TokenManager {
	m := &TokenManager{
		auth:         a,
		refreshToken: refreshToken,
		now:          time.Now,
	}
	for _, opt := range opts {
		opt(m)
	}
	return m
}

// AccessToken returns a valid access token, refreshing on demand. It
// returns the cached token while it has at least tokenManagerRefreshLead
// of life; otherwise it performs (or joins) a single refresh. A
// refresh_invalid error (SPEC §3.1) is terminal — the caller should
// discard its stored refresh token and re-run its login/enrollment flow.
func (m *TokenManager) AccessToken(ctx ctxpkg.Context) (string, error) {
	m.mu.Lock()
	if m.accessToken != "" && m.accessExpiresAt.Sub(m.now()) >= tokenManagerRefreshLead {
		tok := m.accessToken
		m.mu.Unlock()
		return tok, nil
	}
	// Join an in-flight acquisition rather than starting a second one —
	// two parallel /auth/token calls on the same one-time-use refresh
	// would trip reuse-detection.
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

// RefreshToken returns the manager's current refresh token (the latest
// rotated value). Useful for a final persist on graceful shutdown.
func (m *TokenManager) RefreshToken() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.refreshToken
}

// fetch performs one /auth/token acquisition. Only ever called by the
// single-flight leader in AccessToken.
func (m *TokenManager) fetch(ctx ctxpkg.Context, refresh string) (string, error) {
	mr, err := m.auth.Token(ctx, TokenRequest{RefreshToken: refresh, TenantID: m.tenantID})
	if err != nil {
		// refresh_invalid (and any other error) bubbles up unchanged: a
		// long-lived user client has no API key to fall back on, so a dead
		// refresh is terminal — re-authentication is required.
		return "", err
	}
	if mr.AccessToken == "" {
		return "", &RealmError{Code: ErrCodeServerError, Message: "/auth/token returned empty access token"}
	}
	rotated := mr.RefreshToken
	if rotated == "" {
		// User refresh always rotates; guard anyway so a non-rotating realm
		// config (service/platform) doesn't blank the stored token.
		rotated = refresh
	}
	// Commit the rotated token to memory BEFORE persisting, so if the sink
	// fails and the caller retries, the retry presents the live (just
	// issued, unconsumed) token rather than the consumed one.
	m.mu.Lock()
	m.refreshToken = rotated
	m.mu.Unlock()

	// Persist-before-return: the sink must durably store the rotated token
	// before we hand the caller an access token to use (SPEC §4.2.1).
	if m.sink != nil {
		if serr := m.sink(ctx, rotated); serr != nil {
			return "", fmt.Errorf("realmid token manager: persist rotated refresh token: %w", serr)
		}
	}

	exp := m.now().Add(time.Duration(mr.ExpiresIn) * time.Second)
	if mr.ExpiresIn == 0 {
		exp = m.now().Add(5 * time.Minute) // SPEC §4.0 default
	}
	m.mu.Lock()
	m.accessToken = mr.AccessToken
	m.accessExpiresAt = exp
	m.mu.Unlock()
	return mr.AccessToken, nil
}

// HandleStale answers an ADR-107 `token_stale` 401 by forcing ONE refresh and
// returning the token to replay the original request with.
//
// D13, the loop-breaker. D8 makes the C5 loop very unlikely by stamping the
// marker early; this makes it impossible, and it lives in the client SDK
// because that is where the retry decision is actually made. A second
// token_stale on a token this method already produced is a HARD failure —
// returned as token_stale so the caller can surface it, never retried.
//
// staleToken is the token the failing request carried. Passing a token that is
// no longer the manager's current one is not an error: another goroutine
// already refreshed, and the caller simply gets the newer token to replay with,
// costing the issuer nothing.
//
// Usage:
//
//	tok, err := tm.AccessToken(ctx)
//	res, err := call(tok)
//	if realmid.IsTokenStale(err) {
//	    tok, err = tm.HandleStale(ctx, tok)   // hard-fails on the second try
//	    if err != nil { return err }          // surface it; do NOT loop
//	    res, err = call(tok)
//	}
func (m *TokenManager) HandleStale(ctx ctxpkg.Context, staleToken string) (string, error) {
	m.mu.Lock()
	if staleToken != "" && staleToken == m.forcedToken {
		m.mu.Unlock()
		return "", &RealmError{
			Code:       ErrCodeTokenStale,
			HTTPStatus: 401,
			Message: "realmid: token_stale on a token minted by the previous forced refresh — " +
				"refusing to refresh again (ADR-107 D13). The authority marker is ahead of the " +
				"issuer's clock, or the subject is being re-marked faster than a token can be used.",
		}
	}
	// Someone else already refreshed past the failing token — replay with what
	// we hold rather than spending a mint.
	if staleToken != "" && m.accessToken != "" && staleToken != m.accessToken {
		tok := m.accessToken
		m.mu.Unlock()
		return tok, nil
	}
	// Drop the cached token so AccessToken cannot hand back the stale one.
	m.accessToken = ""
	m.accessExpiresAt = time.Time{}
	m.mu.Unlock()

	tok, err := m.AccessToken(ctx)
	if err != nil {
		return "", err
	}
	m.mu.Lock()
	m.forcedToken = tok
	m.mu.Unlock()
	return tok, nil
}
