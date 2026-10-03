package realmid

// SPEC §6.7.5 — the one store behind every piece of cross-request session
// state: revoked sessions, not-before marks, the refresh lock and its outcome
// handoff. REQUIRED on Config (ErrSessionStoreRequired).

import (
	ctxpkg "context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"time"
)

// ErrSessionStoreRequired is returned (wrapped) by NewRealm when
// Config.SessionStore is nil.
var ErrSessionStoreRequired = errors.New("realmid: Config.SessionStore is required (use realmid.NewMemorySessionStore() for a single replica)")

// sessionStateLifetime is H, the issuer's access-TTL ceiling (SPEC §6.7.2):
// every revoked entry and every mark lives until now+H.
const sessionStateLifetime = 24 * time.Hour

// SessionState is the live state of one key. The zero value means absent.
type SessionState struct {
	Revoked   bool
	NotBefore time.Time // zero = none
}

// SessionStateStore holds all cross-request session state (SPEC §6.7.5). A
// multi-replica partner supplies a shared implementation.
type SessionStateStore interface {
	// RevokeSession marks key revoked. The entry lives until the LATEST `until`
	// ever written for key: a write never shortens it. Atomic per key.
	RevokeSession(ctx ctxpkg.Context, key string, until time.Time) error
	// RaiseNotBefore stores max(stored, nb) — never lowers it — and extends the
	// entry's life to max(stored until, until). Both maxima in ONE atomic step.
	RaiseNotBefore(ctx ctxpkg.Context, key string, nb, until time.Time) error
	// SessionStates returns the live state of each key, in order (the zero
	// value for an absent or expired key). One round trip; NOT required to be
	// atomic across keys.
	SessionStates(ctx ctxpkg.Context, keys []string) ([]SessionState, error)
	// Evict drops every entry whose key equals prefix or starts with prefix+"|".
	// A prefix match: a shared implementation (Redis) must SCAN or index for it.
	Evict(ctx ctxpkg.Context, prefix string) error

	// AcquireRefreshLock is SET-IF-ABSENT WITH TTL, atomically. `release` is
	// FENCED: it frees the lock only if this holder still owns it.
	AcquireRefreshLock(ctx ctxpkg.Context, key string, ttl time.Duration) (acquired bool, release func(ctx ctxpkg.Context) error, err error)
	// PutRefreshResult stores an opaque SDK-encoded outcome holding live
	// credentials, for exactly ttl (never extended).
	PutRefreshResult(ctx ctxpkg.Context, key string, result []byte, ttl time.Duration) error
	GetRefreshResult(ctx ctxpkg.Context, key string) (result []byte, ok bool, err error)
}

// ---- key namespaces (SPEC §6.7.5) ----

const sessionKeyPrefix = "realmid:v1:"

func escapeKeyPart(s string) string {
	s = strings.ReplaceAll(s, "%", "%25")
	return strings.ReplaceAll(s, "|", "%7C")
}

func joinKey(parts ...string) string {
	esc := make([]string, len(parts))
	for i, p := range parts {
		esc[i] = escapeKeyPart(p)
	}
	return sessionKeyPrefix + strings.Join(esc, "|")
}

func revokedKey(sessionKey string) string     { return joinKey("rev", sessionKey) }
func sessionMarkKey(sessionKey string) string { return joinKey("nb", sessionKey) }
func membershipMarkKey(sessionKey, sub string) string {
	return joinKey("nb", sessionKey, sub)
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func refreshLockKey(refreshToken string) string    { return joinKey("lock", tokenHash(refreshToken)) }
func refreshOutcomeKey(refreshToken string) string { return joinKey("out", tokenHash(refreshToken)) }

// ---- in-memory implementation ----

type memEntry struct {
	revoked bool
	nb      time.Time
	until   time.Time
}

type memLock struct {
	owner int64
	until time.Time
}

type memResult struct {
	val   []byte
	until time.Time
}

// MemorySessionStore is the single-process SessionStateStore. Two Realms given
// two stores share nothing.
//
// It is per replica and meant for small deployments: every write may, at most
// once per 30 s, walk all of its maps (locks, refresh outcomes, revocation
// entries) under the one store lock to drop expired entries. That is cheap for
// a few thousand live entries and a stall for very many. A multi-replica or
// large deployment should use a shared store (the Redis one): it also shares
// the refresh lock and outcomes across replicas, which this one cannot.
type MemorySessionStore struct {
	mu      sync.Mutex
	now     func() time.Time
	entries map[string]*memEntry
	locks   map[string]memLock
	results map[string]memResult
	nextID  int64
	// nextSweep is when the next amortised sweep of expired locks, outcomes and
	// revocation entries runs (see sweepLocked).
	nextSweep time.Time
}

// memSweepInterval is how often a write sweeps expired entries. Outcomes hold
// LIVE tokens for a 5 s window, so they must not outlive it by more than this;
// a goroutine would need a Close and this store has none.
const memSweepInterval = 30 * time.Second

// sweepLocked drops every expired lock, outcome and revocation entry, at most
// once per memSweepInterval. Called with m.mu held, from the write paths: an
// entry nobody reads again (a refresh token used once) is otherwise never
// evicted, and an outcome carries a live access and refresh token.
func (m *MemorySessionStore) sweepLocked() {
	now := m.now()
	if now.Before(m.nextSweep) {
		return
	}
	m.nextSweep = now.Add(memSweepInterval)
	for k, l := range m.locks {
		if !l.until.After(now) {
			delete(m.locks, k)
		}
	}
	for k, r := range m.results {
		if !r.until.After(now) {
			delete(m.results, k)
		}
	}
	for k, e := range m.entries {
		if !e.until.After(now) {
			delete(m.entries, k)
		}
	}
}

// NewMemorySessionStore returns an empty in-memory store.
func NewMemorySessionStore() *MemorySessionStore {
	return &MemorySessionStore{
		now:     time.Now,
		entries: map[string]*memEntry{},
		locks:   map[string]memLock{},
		results: map[string]memResult{},
	}
}

func (m *MemorySessionStore) live(key string) *memEntry {
	e, ok := m.entries[key]
	if !ok {
		return nil
	}
	if !e.until.After(m.now()) {
		delete(m.entries, key)
		return nil
	}
	return e
}

func (m *MemorySessionStore) RevokeSession(_ ctxpkg.Context, key string, until time.Time) error {
	if key == "" {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.live(key)
	if e == nil {
		e = &memEntry{}
		m.entries[key] = e
	}
	e.revoked = true
	if until.After(e.until) {
		e.until = until
	}
	return nil
}

func (m *MemorySessionStore) RaiseNotBefore(_ ctxpkg.Context, key string, nb, until time.Time) error {
	if key == "" {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.live(key)
	if e == nil {
		e = &memEntry{}
		m.entries[key] = e
	}
	if nb.After(e.nb) {
		e.nb = nb
	}
	if until.After(e.until) {
		e.until = until
	}
	return nil
}

func (m *MemorySessionStore) SessionStates(_ ctxpkg.Context, keys []string) ([]SessionState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]SessionState, len(keys))
	for i, k := range keys {
		if e := m.live(k); e != nil {
			out[i] = SessionState{Revoked: e.revoked, NotBefore: e.nb}
		}
	}
	return out, nil
}

// Evict drops entries by prefix; an empty prefix clears everything held.
func (m *MemorySessionStore) Evict(_ ctxpkg.Context, prefix string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if prefix == "" {
		m.entries = map[string]*memEntry{}
		return nil
	}
	for k := range m.entries {
		if k == prefix || strings.HasPrefix(k, prefix+"|") {
			delete(m.entries, k)
		}
	}
	return nil
}

// Len returns the live entry count (tests, instrumentation).
func (m *MemorySessionStore) Len() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for k := range m.entries {
		if m.live(k) != nil {
			n++
		}
	}
	return n
}

func (m *MemorySessionStore) AcquireRefreshLock(_ ctxpkg.Context, key string, ttl time.Duration) (bool, func(ctxpkg.Context) error, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sweepLocked()
	if l, ok := m.locks[key]; ok && l.until.After(m.now()) {
		return false, func(ctxpkg.Context) error { return nil }, nil
	}
	m.nextID++
	id := m.nextID
	m.locks[key] = memLock{owner: id, until: m.now().Add(ttl)}
	return true, func(ctxpkg.Context) error {
		m.mu.Lock()
		defer m.mu.Unlock()
		if l, ok := m.locks[key]; ok && l.owner == id {
			delete(m.locks, key)
		}
		return nil
	}, nil
}

func (m *MemorySessionStore) PutRefreshResult(_ ctxpkg.Context, key string, result []byte, ttl time.Duration) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sweepLocked()
	m.results[key] = memResult{val: append([]byte(nil), result...), until: m.now().Add(ttl)}
	return nil
}

func (m *MemorySessionStore) GetRefreshResult(_ ctxpkg.Context, key string) ([]byte, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.results[key]
	if !ok {
		return nil, false, nil
	}
	if !r.until.After(m.now()) {
		delete(m.results, key)
		return nil, false, nil
	}
	return append([]byte(nil), r.val...), true, nil
}
