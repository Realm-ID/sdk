package realmid

// Round-2 pins: outcome-read errors never mint, MemorySessionStore eviction,
// empty RefreshToken takes no lock, selfEnrollMfa takes no lock.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// getErrStore fails GetRefreshResult while armed (a transient Redis GET error).
type getErrStore struct {
	*MemorySessionStore
	armed atomic.Bool
}

func (s *getErrStore) GetRefreshResult(ctx context.Context, k string) ([]byte, bool, error) {
	if s.armed.Load() {
		return nil, false, errors.New("redis GET timeout")
	}
	return s.MemorySessionStore.GetRefreshResult(ctx, k)
}

func TestToken_OutcomeReadErrorNeverMints(t *testing.T) {
	st := &getErrStore{MemorySessionStore: NewMemorySessionStore()}
	e := newRFEnv(t, rfOpts{store: st})
	if _, err := e.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: "rt-old", TenantID: "t1"}); err != nil {
		t.Fatal(err)
	}
	st.armed.Store(true)
	_, err := e.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: "rt-old", TenantID: "t1"})
	if !IsCode(err, ErrCodeServerError) || !strings.Contains(err.Error(), "session store unavailable") {
		t.Fatalf("err = %v, want 503 session store unavailable", err)
	}
	if e.issuerCalls() != 1 {
		t.Fatalf("issuer saw %v: the spent token was re-presented", e.seenTokens())
	}
}

func TestMiddlewareRefresh_OutcomeReadErrorNeverMints(t *testing.T) {
	st := &getErrStore{MemorySessionStore: NewMemorySessionStore()}
	e := newRFEnv(t, rfOpts{store: st})
	if w := e.post("/token", "rt-old", `{"tenant_id":"t1"}`); w.Code != 200 {
		t.Fatalf("first: %d %s", w.Code, w.Body.String())
	}
	st.armed.Store(true)
	w := e.post("/token", "rt-old", `{"tenant_id":"t1"}`)
	if w.Code != 503 || !strings.Contains(w.Body.String(), "session store unavailable") || e.issuerCalls() != 1 {
		t.Fatalf("%d %s issuer=%v", w.Code, w.Body.String(), e.seenTokens())
	}
}

// ctxStore honours ctx on reads and cancels the caller's ctx the moment the lock
// is taken: a caller that goes away after acquiring must not turn a stored
// outcome into a miss.
type ctxStore struct {
	*MemorySessionStore
	cancel context.CancelFunc
}

func (s *ctxStore) AcquireRefreshLock(ctx context.Context, k string, ttl time.Duration) (bool, func(context.Context) error, error) {
	ok, rel, err := s.MemorySessionStore.AcquireRefreshLock(ctx, k, ttl)
	if ok && s.cancel != nil {
		s.cancel()
	}
	return ok, rel, err
}

func (s *ctxStore) GetRefreshResult(ctx context.Context, k string) ([]byte, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	return s.MemorySessionStore.GetRefreshResult(ctx, k)
}

func TestToken_CallerCancelAfterLockStillReadsTheOutcome(t *testing.T) {
	st := &ctxStore{MemorySessionStore: NewMemorySessionStore()}
	e := newRFEnv(t, rfOpts{store: st})
	if _, err := e.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: "rt-old", TenantID: "t1"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	st.cancel = cancel
	mr, err := e.realm.Auth.Token(ctx, TokenRequest{RefreshToken: "rt-old", TenantID: "t1"})
	if err != nil || mr.RefreshToken != "rt-new-1" || e.issuerCalls() != 1 {
		t.Fatalf("mr=%+v err=%v issuer=%v", mr, err, e.seenTokens())
	}
}

func TestMemorySessionStore_SweepsExpiredOutcomesAndLocks(t *testing.T) {
	st := NewMemorySessionStore()
	clock := time.Now()
	st.now = func() time.Time { return clock }
	ctx := context.Background()
	for i := 0; i < 50; i++ {
		k := fmt.Sprintf("k%d", i)
		_ = st.PutRefreshResult(ctx, k, []byte("live-token"), 5*time.Second)
		_, _, _ = st.AcquireRefreshLock(ctx, k, 15*time.Second) // abandoned, never released
	}
	clock = clock.Add(time.Hour)
	_ = st.PutRefreshResult(ctx, "late", []byte("x"), 5*time.Second)
	_, _, _ = st.AcquireRefreshLock(ctx, "late", 15*time.Second)
	st.mu.Lock()
	nr, nl := len(st.results), len(st.locks)
	st.mu.Unlock()
	if nr != 1 || nl != 1 {
		t.Fatalf("after +1h: %d outcomes, %d locks left; want 1 and 1 (expired entries must not accumulate)", nr, nl)
	}
}

func TestToken_EmptyRefreshTokenTakesNoLock(t *testing.T) {
	st := &lockErrStore{MemorySessionStore: NewMemorySessionStore()}
	e := newRFEnv(t, rfOpts{store: st})
	if _, err := e.realm.Auth.Token(context.Background(), TokenRequest{TenantID: "t1"}); err != nil {
		t.Fatalf("token: %v", err)
	}
	if st.acquires.Load() != 0 || e.issuerCalls() != 1 {
		t.Fatalf("acquires=%d issuer=%d", st.acquires.Load(), e.issuerCalls())
	}
}

// selfEnrollMfa carries a refresh token but the issuer does not rotate it
// there, so it takes no lock (SPEC §4.8).
func TestSelfEnrollMFA_TakesNoLock(t *testing.T) {
	st := &lockErrStore{MemorySessionStore: NewMemorySessionStore()}
	e := newRFEnv(t, rfOpts{store: st})
	_, _ = e.realm.Auth.SelfEnrollMFA(context.Background(), SelfEnrollMFARequest{RefreshToken: "rt-old", TenantID: "t1"})
	if st.acquires.Load() != 0 {
		t.Fatal("selfEnrollMfa must not take the refresh lock")
	}
}

func seedSuperseded(t *testing.T, st *MemorySessionStore, chain ...string) {
	t.Helper()
	for i := 0; i+1 < len(chain); i++ {
		raw, _ := json.Marshal(refreshOutcome{Fingerprint: "someone-else", Mint: &MintResult{RefreshToken: chain[i+1]}})
		if err := st.PutRefreshResult(context.Background(), refreshOutcomeKey(chain[i]), raw, time.Minute); err != nil {
			t.Fatal(err)
		}
	}
}

func TestToken_SupersededGiveUpCarriesTheTokenRedacted(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	seedSuperseded(t, e.store, "rt-old", "rt-1", "rt-2", "rt-SECRET")
	_, err := e.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: "rt-old", TenantID: "t1"})
	var se *RefreshSupersededError
	if !errors.As(err, &se) || se.RefreshToken() != "rt-SECRET" || !IsCode(err, ErrCodeServerError) {
		t.Fatalf("err = %v", err)
	}
	b, _ := json.Marshal(se)
	for _, s := range []string{fmt.Sprintf("%v", err), fmt.Sprintf("%+v", err), fmt.Sprintf("%#v", err), fmt.Sprintf("%v", se), fmt.Sprintf("%#v", se), string(b)} {
		if strings.Contains(s, "rt-SECRET") {
			t.Fatalf("live refresh token leaked: %q", s)
		}
	}
	if e.issuerCalls() != 0 {
		t.Fatal("the issuer must not be called")
	}
}

func TestTokenManager_AdoptsTheTokenFromASupersededGiveUp(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	seedSuperseded(t, e.store, "rt-old", "rt-1", "rt-2", "rt-3")
	m := e.realm.Auth.NewTokenManager("rt-old")
	if _, err := m.AccessToken(context.Background()); err == nil {
		t.Fatal("want the superseded give-up error")
	}
	if got := m.RefreshToken(); got != "rt-3" {
		t.Fatalf("manager still holds %q; the next attempt would present a spent token", got)
	}
}
