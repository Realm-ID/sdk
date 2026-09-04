// Package realmid — subject-keyed authority cache (ADR-107).
//
// The ADR-041 RevocationCache is a jti DENYLIST, and that is the whole of what
// it can express. It works for logout for exactly one reason: the user presents
// their own token, so the SDK holds the jti at the moment it needs to deny it.
//
// An admin demoting a colleague holds neither that colleague's access token nor
// its jti, and there is no user → live-jti lookup anywhere in the SDK. So
// demotion is not "a missing feature of RevocationCache" — it is structurally
// inexpressible there, no matter what the interface is called (ADR-107 C2).
//
// AuthorityCache is the second cache that ADR-107 D1 puts BESIDE it, never
// instead of it: keyed by `sub`, storing a timestamp. RevocationCache is
// untouched and keeps serving logout.
package realmid

import (
	ctxpkg "context"
	"sync"
	"time"
)

// AuthorityCache records, per subject, the instant from which tokens are no
// longer trusted to describe that subject's authority. A token is rejected iff
// its `iat` predates the stored marker.
//
// The value is a TIMESTAMP and never a flag (ADR-107 D3). A boolean cannot
// self-heal: it would reject the REFRESHED token too, locking the user out for
// the entry's whole TTL and turning a routine demotion into an outage.
//
// Reads are on the hot path of every authenticated request, so implementations
// should keep StaleSince cheap. Errors propagate to the verifier, which fails
// closed (the request is rejected).
type AuthorityCache interface {
	// MarkStale records that tokens for sub minted before notBefore no longer
	// describe its authority. expiresAt is the entry's TTL — the maximum
	// access-token lifetime plus leeway, after which no token minted before the
	// change can still verify and the entry is dead weight (D6).
	MarkStale(ctx ctxpkg.Context, sub string, notBefore, expiresAt time.Time) error
	// StaleSince returns the marker for sub. found is false when the subject
	// has no live entry.
	StaleSince(ctx ctxpkg.Context, sub string) (notBefore time.Time, found bool, err error)
}

// MemAuthorityCache is the single-process default, lazily evicting on read
// exactly as MemRevocationCache does.
//
// ⚠️ It is correct for ONE replica and for tests, and silently wrong for more:
// a marker written on replica A is invisible to replica B, so a demotion
// propagates only to whichever replica happens to serve the next request. A
// multi-replica partner supplies Redis or equivalent — under D1 that is a
// DEPLOYMENT REQUIREMENT, not a tuning choice.
type MemAuthorityCache struct {
	mu      sync.RWMutex
	entries map[string]authorityEntry
	now     func() time.Time
}

type authorityEntry struct {
	notBefore time.Time
	expiresAt time.Time
}

// NewMemAuthorityCache returns an empty MemAuthorityCache. now is the clock;
// pass nil to default to time.Now.
func NewMemAuthorityCache(now func() time.Time) *MemAuthorityCache {
	if now == nil {
		now = time.Now
	}
	return &MemAuthorityCache{entries: map[string]authorityEntry{}, now: now}
}

// MarkStale implements AuthorityCache.
func (m *MemAuthorityCache) MarkStale(_ ctxpkg.Context, sub string, notBefore, expiresAt time.Time) error {
	if sub == "" {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	// A later marker always wins. An EARLIER one is dropped rather than
	// stored: moving the marker backwards would un-stale tokens a previous
	// change had already invalidated.
	if prev, ok := m.entries[sub]; ok && prev.notBefore.After(notBefore) {
		notBefore = prev.notBefore
	}
	m.entries[sub] = authorityEntry{notBefore: notBefore, expiresAt: expiresAt}
	return nil
}

// StaleSince implements AuthorityCache.
func (m *MemAuthorityCache) StaleSince(_ ctxpkg.Context, sub string) (time.Time, bool, error) {
	if sub == "" {
		return time.Time{}, false, nil
	}
	m.mu.RLock()
	e, ok := m.entries[sub]
	m.mu.RUnlock()
	if !ok {
		return time.Time{}, false, nil
	}
	if !e.expiresAt.IsZero() && m.now().After(e.expiresAt) {
		m.mu.Lock()
		delete(m.entries, sub)
		m.mu.Unlock()
		return time.Time{}, false, nil
	}
	return e.notBefore, true, nil
}

// Len returns the current entry count. Useful for tests + instrumentation.
func (m *MemAuthorityCache) Len() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.entries)
}

// ---- The notify method (ADR-107 D7, D11, D15) ------------------------------

// AuthorityChangeIntent states what the partner did. It is REQUIRED and
// validated rather than inferred (D11): demotion does not evict the session,
// and a method that guessed would eventually guess "log them out" on a routine
// role edit. Removing someone from an org is a different intent with a
// different consequence — that one is Sessions.RevokeUser (ADR-080).
type AuthorityChangeIntent string

const (
	// AuthorityIntentDemoted — the subject's authority was narrowed. They stay
	// signed in and refresh into a narrower token (D11).
	AuthorityIntentDemoted AuthorityChangeIntent = "demoted"
	// AuthorityIntentPromoted — the subject's authority was widened. Without
	// this, the grant has landed and the product says no for up to
	// access_ttl_seconds (C3).
	AuthorityIntentPromoted AuthorityChangeIntent = "promoted"
)

// AuthorityChange is one authority change the partner is announcing.
type AuthorityChange struct {
	// Subject is the `sub` claim of the affected principal — on this platform
	// the PER-MEMBERSHIP users-row id, not a person (D4). Demoting someone in
	// org A deliberately leaves their org B token untouched. A partner that
	// passes an identity id here silently propagates nothing.
	Subject string
	// Intent is required; see AuthorityChangeIntent.
	Intent AuthorityChangeIntent
	// AccessTokenTTL overrides the realm's access-token lifetime when sizing
	// the cache entry (D6). Zero uses DefaultAccessTokenTTL. Set it when the
	// realm's access_ttl_seconds differs from the service default, or entries
	// expire while tokens minted before the change are still verifiable.
	AccessTokenTTL time.Duration
}

// DefaultAccessTokenTTL mirrors the issuer's service-level access-token
// lifetime, which sizes the cache entry under D6.
const DefaultAccessTokenTTL = 15 * time.Minute

// authorityStaleSkew is D8's allowance. The marker is stamped as
// localNow − authorityStaleSkew, NEVER as bare localNow.
//
// This is the load-bearing constant of the whole design. Erring EARLY
// over-rejects a handful of very recently minted tokens — one extra, harmless
// refresh each. Erring LATE places the marker in the ISSUER's future, so a
// freshly-minted token fails the same check that caused the refresh, and every
// replica refreshes, fails, and refreshes again against the mint endpoint.
// ADR-107 C5 calls that loop a worse outcome than the 900-second window it is
// trying to close.
const authorityStaleSkew = 30 * time.Second

// NotifyAuthorityChanged announces that a principal's authority changed, so
// tokens minted before now stop being trusted to describe it.
//
// This is the ONE method a partner calls (D7). The SDK owns everything after
// it: storage, TTLs, the verifier check, the wire code, and the client-side
// retry cap. Nothing in the issuer changes.
//
// The change propagates to tokens presented from now on; the user's next API
// call answers 401 token_stale and their client refreshes once, transparently.
// A user idle at the moment of the change is caught the instant they do
// anything.
//
// ⚠️ Out-of-band changes are NOT covered (D14). A role edited from the RealmID
// console, the CLI, or a back-office that does not call this method stays stale
// for up to the realm's access_ttl_seconds. That is the accepted cost of a
// partner-local cache, and it is the number to quote publicly — not the ~0 on
// notified paths.
func (r *Realm) NotifyAuthorityChanged(ctx ctxpkg.Context, ch AuthorityChange) error {
	// D15: an unconfigured cache is an ERROR, never a no-op. Silence here means
	// a partner believes demotion is propagating while nothing is stored — the
	// "cache that reports nothing" failure this workspace has recorded before.
	if r.authority == nil {
		return &RealmError{
			Code: ErrCodeBadRequest,
			Message: "realmid: NotifyAuthorityChanged called with no AuthorityCache configured — " +
				"set Config.Authority (ADR-107 D15); nothing was recorded",
		}
	}
	if ch.Subject == "" {
		return &RealmError{
			Code:    ErrCodeBadRequest,
			Message: "realmid: AuthorityChange.Subject is required — pass the `sub` claim (the per-membership users-row id, ADR-107 D4)",
		}
	}
	switch ch.Intent {
	case AuthorityIntentDemoted, AuthorityIntentPromoted:
	default:
		return &RealmError{
			Code: ErrCodeBadRequest,
			Message: "realmid: AuthorityChange.Intent must be " +
				string(AuthorityIntentDemoted) + " or " + string(AuthorityIntentPromoted) +
				" — the SDK will not infer it (ADR-107 D11). To sign the principal out, use Sessions.RevokeUser.",
		}
	}

	ttl := ch.AccessTokenTTL
	if ttl <= 0 {
		ttl = DefaultAccessTokenTTL
	}
	now := r.clock()
	notBefore := now.Add(-authorityStaleSkew)
	// D6: the entry outlives every token that could still carry the old
	// authority — the access-token lifetime, plus the same skew allowance so a
	// token minted just before the marker cannot outlive the marker itself.
	expiresAt := now.Add(ttl + authorityStaleSkew)

	if err := r.authority.MarkStale(ctx, ch.Subject, notBefore, expiresAt); err != nil {
		return &RealmError{
			Code:    ErrCodeServerError,
			Message: "realmid: authority cache write failed: " + err.Error(),
			Cause:   err,
		}
	}
	return nil
}
