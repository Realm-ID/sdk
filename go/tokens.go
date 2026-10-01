// Package realmid — session revocation cache (SPEC §6.7).
//
// RealmID revokes refresh tokens server-side (POST /auth/logout, reuse
// detection). Access tokens are stateless RS256 JWTs, so a partner app learns
// of neither. This client holds partner-side state about SESSIONS in the
// realm's SessionStateStore and refuses an access token whose session is
// revoked, or that a later refresh superseded (iat below the not-before mark).
package realmid

import (
	ctxpkg "context"
	"errors"
	"log/slog"
	"time"
)

// ErrTokenRevoked is returned by TokensClient.GateRequest when the access
// token's session is revoked or superseded. Wrapped in a *RealmError so
// callers can unify on RealmError-style branching; errors.Is(err,
// ErrTokenRevoked) also works.
var ErrTokenRevoked = errors.New("realmid: access token revoked")

// LogoutFn is the shape of AuthClient.Logout that TokensClient.RevokeOnLogout
// wraps. Decoupled as an alias so callers can also wrap their own
// logout helpers (e.g. ones that talk through a partner BFF).
type LogoutFn func(ctx ctxpkg.Context, req *LogoutRequest) error

// Org-session modes (SPEC §6.7.3).
const (
	OrgSessionsConcurrent = "concurrent"
	OrgSessionsExclusive  = "exclusive"
)

// TokensClient is the session-revocation surface. Concurrent-safe (the store
// is).
type TokensClient struct {
	store SessionStateStore
	now   func() time.Time
	log   *slog.Logger
	// mode resolves the realm's org-session mode for the token's issuer.
	mode func(ctx ctxpkg.Context, iss string) string
}

// newTokensClient builds a TokensClient over store. now defaults to time.Now,
// mode to "always concurrent", log to a discarding logger.
func newTokensClient(now func() time.Time, store SessionStateStore, log *slog.Logger, mode func(ctxpkg.Context, string) string) *TokensClient {
	if now == nil {
		now = time.Now
	}
	if log == nil {
		log = noopLogger()
	}
	if mode == nil {
		mode = func(ctxpkg.Context, string) string { return OrgSessionsConcurrent }
	}
	return &TokensClient{store: store, now: now, log: log, mode: mode}
}

func (t *TokensClient) until() time.Time { return t.now().Add(sessionStateLifetime) }

// MarkRevoked records the token's SESSION revoked until now+H. No-op when the
// token has no session key. Peeks, never verifies.
func (t *TokensClient) MarkRevoked(ctx ctxpkg.Context, accessToken string) {
	p, err := peekSession(accessToken)
	if err != nil {
		return
	}
	t.RevokeSession(ctx, p.Key)
}

// RevokeSession records the named session revoked until now+H. No-op on an
// empty key. A write error is logged, never returned.
func (t *TokensClient) RevokeSession(ctx ctxpkg.Context, sessionKey string) {
	if sessionKey == "" {
		return
	}
	if err := t.store.RevokeSession(ctx, revokedKey(sessionKey), t.until()); err != nil {
		t.log.Warn("realmid: session store write failed", slog.String("op", "revoke"), slog.Any("error", err))
	}
}

// RecordRefresh raises the session mark and the membership mark to the new
// token's iat. Call it only for a refresh that ROTATED the refresh token.
// No-op without a session key, sub or iat.
func (t *TokensClient) RecordRefresh(ctx ctxpkg.Context, newAccessToken string) {
	p, err := peekSession(newAccessToken)
	if err != nil || p.Key == "" || p.Sub == "" || p.IAT <= 0 {
		return
	}
	nb := time.Unix(p.IAT, 0)
	for _, k := range []string{sessionMarkKey(p.Key), membershipMarkKey(p.Key, p.Sub)} {
		if err := t.store.RaiseNotBefore(ctx, k, nb, t.until()); err != nil {
			t.log.Warn("realmid: session store write failed", slog.String("op", "raise_not_before"), slog.Any("error", err))
		}
	}
}

// IsRevoked reports whether the token's session is revoked, or the not-before
// mark the realm's mode selects is live and the token's iat is strictly below
// it. A store read error is FAIL-OPEN (logged). False on malformed input.
func (t *TokensClient) IsRevoked(ctx ctxpkg.Context, accessToken string) bool {
	p, err := peekSession(accessToken)
	if err != nil || p.Key == "" {
		return false
	}
	keys := []string{revokedKey(p.Key), sessionMarkKey(p.Key)}
	if p.Sub != "" {
		keys = append(keys, membershipMarkKey(p.Key, p.Sub))
	}
	states, err := t.store.SessionStates(ctx, keys)
	if err != nil || len(states) != len(keys) {
		t.log.Warn("realmid: session store read failed; failing open", slog.Any("error", err))
		return false
	}
	if states[0].Revoked {
		return true
	}
	sessionNB := states[1].NotBefore
	var memberNB time.Time
	if len(states) == 3 {
		memberNB = states[2].NotBefore
	}
	if sessionNB.IsZero() && memberNB.IsZero() {
		return false // no live mark: the mode is never fetched
	}
	nb := memberNB
	if t.mode(ctx, p.Iss) == OrgSessionsExclusive {
		nb = sessionNB
	}
	if nb.IsZero() {
		return false
	}
	if p.IAT <= 0 {
		return true // no numeric iat against a live selected mark
	}
	return p.IAT < nb.Unix()
}

// GateRequest is the per-request gate: it returns ErrTokenRevoked (wrapped in
// a *RealmError, code "unauthorized", details.revoked=true) when IsRevoked.
// Nil otherwise, including for malformed tokens — the verifier surfaces those.
func (t *TokensClient) GateRequest(ctx ctxpkg.Context, accessToken string) error {
	if !t.IsRevoked(ctx, accessToken) {
		return nil
	}
	return &RealmError{
		Code:       ErrCodeUnauthorized,
		HTTPStatus: 401,
		Message:    "access token revoked",
		Details:    map[string]any{"revoked": true},
		Cause:      ErrTokenRevoked,
	}
}

// RevokeOnLogout wraps a LogoutFn so the token's session is marked revoked on
// **either success or failure** (fail closed). The token is peeked BEFORE the
// network call.
//
// It revokes only the BEARER's own session: a LogoutFn returns just an error,
// so the issuer's `revoked_sids` (LogoutRequest{All: true}) can never reach
// it. Wrapping AuthClient.Logout with it is redundant — AuthClient.Logout
// already revokes every id the issuer names.
func (t *TokensClient) RevokeOnLogout(logoutFn LogoutFn) func(ctx ctxpkg.Context, accessToken string, req *LogoutRequest) error {
	return func(ctx ctxpkg.Context, accessToken string, req *LogoutRequest) error {
		p, perr := peekSession(accessToken)
		err := logoutFn(ctx, req)
		if perr == nil {
			t.RevokeSession(ctx, p.Key)
		}
		return err
	}
}

// Evict drops a session's revoked entry, session mark and every membership
// mark. An empty key clears everything an in-memory store holds; on any other
// store it is a no-op that logs a warning.
func (t *TokensClient) Evict(ctx ctxpkg.Context, sessionKey string) {
	if sessionKey == "" {
		if m, ok := t.store.(*MemorySessionStore); ok {
			_ = m.Evict(ctx, "")
			return
		}
		t.log.Warn("realmid: Evict with an empty key is a no-op on a shared session store")
		return
	}
	for _, k := range []string{revokedKey(sessionKey), sessionMarkKey(sessionKey)} {
		if err := t.store.Evict(ctx, k); err != nil {
			t.log.Warn("realmid: session store evict failed", slog.Any("error", err))
		}
	}
}
