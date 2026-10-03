package realmid

// Second-round pins for the direct-call refresh lock (go 0.64.2 critic round):
// mint-failure outcome, ordering, wait-then-proceed, bound, ctx handling.

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func failHook(_ context.Context, _ *IdentityResolvedEvent) error { return errors.New("hook down") }

// The issuer rotated, then the derived-claims mint failed. The rotated token
// must still reach a refresh waiting on the lock, or the client re-presents the
// spent token and ADR-109 Issuer B revokes the session.
func TestDirectMFA_MintFailureStillStoresRotatedOutcome(t *testing.T) {
	for _, dc := range directCalls() {
		dc := dc
		t.Run(dc.name, func(t *testing.T) {
			e := newRFEnv(t, rfOpts{})
			e.mfaTenant = "t1"
			e.realm.cfg.OnIdentityResolved = failHook
			e.mfaGate = make(chan struct{})
			done := make(chan error, 1)
			go func() { _, err := dc.invoke(e, "rt-old"); done <- err }()
			waitFor(t, func() bool { return dc.calls(e) == 1 })
			refresh := make(chan *httptest.ResponseRecorder, 1)
			go func() { refresh <- e.post("/token", "rt-old", `{"tenant_id":"t1"}`) }()
			time.Sleep(150 * time.Millisecond)
			close(e.mfaGate)
			err := <-done
			var lme *LoginMintError
			if !errors.As(err, &lme) || lme.Session == nil || lme.Session.RefreshToken != dc.rotate {
				t.Fatalf("want LoginMintError carrying %q, got %v", dc.rotate, err)
			}
			w := <-refresh
			if w.Code != 503 || setCookie(w) != dc.rotate || e.issuerCalls() != 0 {
				t.Fatalf("waiting refresh must adopt the rotated token: %d %s cookie=%q issuer=%d",
					w.Code, w.Body.String(), setCookie(w), e.issuerCalls())
			}
		})
	}
}

func TestMiddlewareMFARoutes_MintFailureStillStoresRotatedOutcome(t *testing.T) {
	for _, c := range []struct{ path, rotate string }{{"/mfa/verify", "rt-mfa-1"}, {"/mfa/recovery", "rt-rec-1"}} {
		c := c
		t.Run(c.path, func(t *testing.T) {
			e := newRFEnv(t, rfOpts{opts: MiddlewareOptions{RecoveryPath: "/mfa/recovery"}})
			e.mfaTenant = "t1"
			e.realm.cfg.OnIdentityResolved = failHook
			w := e.post(c.path, "rt-old", `{"challenge_token":"c","code":"1"}`)
			if w.Code == 200 {
				t.Fatalf("setup: the mint was meant to fail: %s", w.Body.String())
			}
			raw, ok, _ := e.store.GetRefreshResult(context.Background(), refreshOutcomeKey("rt-old"))
			if !ok || !strings.Contains(string(raw), `"fp":"mfa-verify"`) || !strings.Contains(string(raw), c.rotate) {
				t.Fatalf("outcome = %q ok=%v (status %d)", raw, ok, w.Code)
			}
		})
	}
}

// orderStore reports, at the moment a lock is RELEASED, whether the outcome was
// already stored: the outcome must land BEFORE the release, or a refresh that
// takes the lock in the gap finds no outcome and re-presents the spent token.
type orderStore struct {
	*MemorySessionStore
	mu       sync.Mutex
	released int
	early    int // releases that found no stored outcome
}

func (s *orderStore) AcquireRefreshLock(ctx context.Context, k string, ttl time.Duration) (bool, func(context.Context) error, error) {
	ok, rel, err := s.MemorySessionStore.AcquireRefreshLock(ctx, k, ttl)
	if !ok || err != nil {
		return ok, rel, err
	}
	return true, func(c context.Context) error {
		_, has, _ := s.MemorySessionStore.GetRefreshResult(c, refreshOutcomeKey("rt-old"))
		s.mu.Lock()
		s.released++
		if !has {
			s.early++
		}
		s.mu.Unlock()
		return rel(c)
	}, nil
}

func TestDirectMFA_OutcomeIsStoredBeforeTheLockIsReleased(t *testing.T) {
	for _, dc := range directCalls() {
		dc := dc
		t.Run(dc.name, func(t *testing.T) {
			st := &orderStore{MemorySessionStore: NewMemorySessionStore()}
			e := newRFEnv(t, rfOpts{store: st})
			if _, err := dc.invoke(e, "rt-old"); err != nil {
				t.Fatal(err)
			}
			st.mu.Lock()
			defer st.mu.Unlock()
			if st.released != 1 || st.early != 0 {
				t.Fatalf("released=%d releasedBeforeOutcome=%d", st.released, st.early)
			}
		})
	}
}

// A direct call that finds a refresh in flight on the same token WAITS, then
// proceeds and calls the issuer exactly once. The token it passes is the one the
// caller holds (the middleware route keys on the cookie it was handed, the same
// way); the issuer resolves the session from the challenge token.
func TestDirectMFA_WaitsBehindInFlightRefreshThenProceedsOnce(t *testing.T) {
	for _, dc := range directCalls() {
		dc := dc
		t.Run(dc.name, func(t *testing.T) {
			e := newRFEnv(t, rfOpts{})
			e.gate = make(chan struct{})
			refresh := make(chan *httptest.ResponseRecorder, 1)
			go func() { refresh <- e.post("/token", "rt-old", `{"tenant_id":"t1"}`) }()
			waitFor(t, func() bool { return e.issuerCalls() == 1 })
			type res struct {
				s   *Session
				err error
			}
			done := make(chan res, 1)
			go func() { s, err := dc.invoke(e, "rt-old"); done <- res{s, err} }()
			time.Sleep(200 * time.Millisecond)
			if dc.calls(e) != 0 {
				t.Fatal("direct call must wait for the in-flight refresh")
			}
			close(e.gate)
			if w := <-refresh; w.Code != 200 {
				t.Fatalf("refresh: %d %s", w.Code, w.Body.String())
			}
			r := <-done
			if r.err != nil || r.s == nil {
				t.Fatalf("direct call after the wait: %v", r.err)
			}
			if dc.calls(e) != 1 || e.issuerCalls() != 1 {
				t.Fatalf("verify calls=%d refresh calls=%d, want 1 and 1", dc.calls(e), e.issuerCalls())
			}
		})
	}
}

// The work under the lock is bounded below the lock TTL (mint timeout), so a
// hung issuer cannot outlive the lock, and the lock is released afterwards.
func TestDirectMFA_WorkUnderTheLockIsBounded(t *testing.T) {
	for _, dc := range directCalls() {
		dc := dc
		t.Run(dc.name, func(t *testing.T) {
			e := newRFEnv(t, rfOpts{})
			e.realm.refreshMintTimeout = 150 * time.Millisecond
			e.mfaGate = make(chan struct{})
			t.Cleanup(func() { close(e.mfaGate) })
			done := make(chan error, 1)
			go func() { _, err := dc.invoke(e, "rt-old"); done <- err }()
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("a hung issuer call must fail once the bound is hit")
				}
			case <-time.After(3 * time.Second):
				t.Fatal("work under the lock is unbounded")
			}
			ok, rel, _ := e.store.AcquireRefreshLock(context.Background(), refreshLockKey("rt-old"), time.Hour)
			if !ok {
				t.Fatal("lock not released after the bound fired")
			}
			_ = rel(context.Background())
		})
	}
}

func TestMiddlewareMFARoutes_WorkUnderTheLockIsBounded(t *testing.T) {
	for _, path := range []string{"/mfa/verify", "/mfa/recovery"} {
		path := path
		t.Run(path, func(t *testing.T) {
			e := newRFEnv(t, rfOpts{opts: MiddlewareOptions{RecoveryPath: "/mfa/recovery"}})
			e.realm.refreshMintTimeout = 150 * time.Millisecond
			e.mfaGate = make(chan struct{})
			t.Cleanup(func() { close(e.mfaGate) })
			done := make(chan *httptest.ResponseRecorder, 1)
			go func() { done <- e.post(path, "rt-old", `{"challenge_token":"c","code":"1"}`) }()
			select {
			case w := <-done:
				if w.Code == 200 {
					t.Fatal("a hung issuer call must not succeed")
				}
			case <-time.After(3 * time.Second):
				t.Fatal("middleware work under the lock is unbounded")
			}
		})
	}
}

// A caller context that ends while waiting returns the context's error promptly
// (no further sleeping) and fails CLOSED: the issuer is never called.
func TestDirectMFA_ContextDoneWhileWaitingReturnsCtxErrorFast(t *testing.T) {
	for _, dc := range directCalls() {
		dc := dc
		t.Run(dc.name, func(t *testing.T) {
			e := newRFEnv(t, rfOpts{})
			_, _, _ = e.store.AcquireRefreshLock(context.Background(), refreshLockKey("rt-old"), time.Hour)
			ctx, cancel := context.WithCancel(context.Background())
			time.AfterFunc(100*time.Millisecond, cancel)
			start := time.Now()
			err := make(chan error, 1)
			go func() { _, e2 := dc.invokeCtx(e, ctx, "rt-old"); err <- e2 }()
			select {
			case got := <-err:
				if !errors.Is(got, context.Canceled) {
					t.Fatalf("err = %v, want context.Canceled", got)
				}
			case <-time.After(1500 * time.Millisecond):
				t.Fatalf("still waiting %v after the context ended", time.Since(start))
			}
			if dc.calls(e) != 0 {
				t.Fatal("issuer must not be called")
			}
		})
	}
}

func TestDirectMFA_ContextDoneBeatsStoreUnavailable(t *testing.T) {
	for _, dc := range directCalls() {
		dc := dc
		t.Run(dc.name, func(t *testing.T) {
			st := &lockErrStore{MemorySessionStore: NewMemorySessionStore()}
			e := newRFEnv(t, rfOpts{store: st})
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			_, err := dc.invokeCtx(e, ctx, "rt-old")
			if !errors.Is(err, context.Canceled) || dc.calls(e) != 0 {
				t.Fatalf("err = %v issuer=%d", err, dc.calls(e))
			}
		})
	}
}
