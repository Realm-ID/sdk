// Package realmid — access-token revocation cache (SPEC §6.7).
//
// Server-side, RealmID revokes refresh tokens via POST /auth/logout.
// Access tokens are stateless RS256 JWTs, so once minted they verify
// on signature + exp alone until natural expiry. This client adds
// partner-side defense-in-depth: on logout, the access token's jti
// is parked in an in-memory cache with TTL = exp - now(). Subsequent
// requests presenting that jti are rejected without a server round
// trip.
//
// Multi-pod caveat: this cache is per-process. A logout served by
// pod A does not propagate to pod B; a stolen access token can
// still be replayed against pod B for up to its remaining TTL. v1.1
// will ship a Redis-backed swap-in for cross-pod coherence.
package realmid

import (
	ctxpkg "context"
	"errors"
	"sync"
	"time"
)

// ErrTokenRevoked is returned by TokensClient.GateRequest when the
// access token's jti is in the per-process revoked cache. Wrapped in
// a *RealmError so callers can unify on RealmError-style branching;
// errors.Is(err, ErrTokenRevoked) also works.
var ErrTokenRevoked = errors.New("realmid: access token revoked")

// LogoutFn is the shape of AuthClient.Logout that TokensClient.RevokeOnLogout
// wraps. Decoupled as an alias so callers can also wrap their own
// logout helpers (e.g. ones that talk through a partner BFF).
type LogoutFn func(ctx ctxpkg.Context, req *LogoutRequest) error

// TokensClient is the access-token revocation cache surface. Concurrent-safe.
type TokensClient struct {
	mu      sync.RWMutex
	entries map[string]time.Time
	now     func() time.Time
}

// newTokensClient builds a TokensClient with the realm's clock (or
// time.Now when unset).
func newTokensClient(now func() time.Time) *TokensClient {
	if now == nil {
		now = time.Now
	}
	return &TokensClient{
		entries: map[string]time.Time{},
		now:     now,
	}
}

// MarkRevoked extracts jti+exp from accessToken and caches the jti
// with TTL = exp - now(). No-op when the token is malformed, the
// jti/exp claims are missing, or exp is already in the past.
func (t *TokensClient) MarkRevoked(accessToken string) {
	jti, exp, err := peekJWTRevokeFields(accessToken)
	if err != nil || jti == "" || exp.IsZero() {
		return
	}
	if !exp.After(t.now()) {
		return
	}
	t.mu.Lock()
	t.entries[jti] = exp
	t.mu.Unlock()
}

// IsRevoked returns true iff accessToken's jti is cached and the
// entry has not expired. Lazy GC: stale entries are evicted on read.
// Returns false on malformed input.
func (t *TokensClient) IsRevoked(accessToken string) bool {
	jti, _, err := peekJWTRevokeFields(accessToken)
	if err != nil || jti == "" {
		return false
	}
	t.mu.RLock()
	exp, ok := t.entries[jti]
	t.mu.RUnlock()
	if !ok {
		return false
	}
	if !exp.After(t.now()) {
		t.mu.Lock()
		delete(t.entries, jti)
		t.mu.Unlock()
		return false
	}
	return true
}

// GateRequest is the per-request gate partner middleware calls before
// forwarding upstream. Returns ErrTokenRevoked (wrapped in a *RealmError
// with code "unauthorized" + details.revoked=true) when accessToken's
// jti is in the cache. Returns nil otherwise (including for malformed
// tokens — let the verifier surface that).
func (t *TokensClient) GateRequest(accessToken string) error {
	if !t.IsRevoked(accessToken) {
		return nil
	}
	return &RealmError{
		Code:    ErrCodeUnauthorized,
		Message: "access token revoked",
		Details: map[string]any{"revoked": true},
		Cause:   ErrTokenRevoked,
	}
}

// RevokeOnLogout wraps a LogoutFn so that the access token's jti is
// marked revoked on **either success or transport failure**. Rationale:
// the partner backend should fail closed — if RealmID is unreachable,
// the access token still gets blackholed locally so the user is logged
// out from the partner's perspective. Returns the wrapped function;
// the original logoutFn is called once per invocation.
func (t *TokensClient) RevokeOnLogout(logoutFn LogoutFn) func(ctx ctxpkg.Context, accessToken string, req *LogoutRequest) error {
	return func(ctx ctxpkg.Context, accessToken string, req *LogoutRequest) error {
		jti, exp, perr := peekJWTRevokeFields(accessToken)
		err := logoutFn(ctx, req)
		if perr == nil && jti != "" && !exp.IsZero() && exp.After(t.now()) {
			t.mu.Lock()
			t.entries[jti] = exp
			t.mu.Unlock()
		}
		return err
	}
}

// Evict drops a single jti, or all entries when jti == "".
func (t *TokensClient) Evict(jti string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if jti == "" {
		t.entries = map[string]time.Time{}
		return
	}
	delete(t.entries, jti)
}

// Len returns the current entry count. Useful for tests + instrumentation.
func (t *TokensClient) Len() int {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return len(t.entries)
}
