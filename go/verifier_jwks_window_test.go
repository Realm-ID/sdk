package realmid

// SPEC §2 — the 5s unknown-kid window gates only the refetch a kid missing from
// a still-fresh set triggers. A caller's own cancellation is never an attempt.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type windowEnv struct {
	realm   *Realm
	sign    func(map[string]any) string
	fetch   *int32
	failing *atomic.Bool
	rotated *atomic.Bool
	gate    *atomic.Pointer[chan struct{}]
	signNew func(map[string]any) string
	step    func(d time.Duration)
	claim   func() map[string]any
}

// newWindowEnv serves a JWKS that answers 500 while failing is set, on a
// controllable clock.
func newWindowEnv(t *testing.T, failing bool) *windowEnv {
	t.Helper()
	sign, key := mintKey(t, "kid-known")
	signNew, keyNew := mintKey(t, "kid-new")
	var n int32
	fail := &atomic.Bool{}
	fail.Store(failing)
	rotated := &atomic.Bool{}
	gate := &atomic.Pointer[chan struct{}]{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&n, 1)
		// While a gate is armed every fetch holds here, so concurrent callers overlap.
		if g := gate.Load(); g != nil {
			<-*g
		}
		if fail.Load() {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		keys := []jwk{key}
		if rotated.Load() {
			keys = append(keys, keyNew)
		}
		_ = json.NewEncoder(w).Encode(jwksDoc{Keys: keys})
	}))
	t.Cleanup(srv.Close)
	clock := time.Now()
	var mu sync.Mutex
	now := func() time.Time { mu.Lock(); defer mu.Unlock(); return clock }
	r, err := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk_live_test", BaseURL: srv.URL, Clock: now})
	if err != nil {
		t.Fatalf("NewRealm: %v", err)
	}
	return &windowEnv{
		realm: r, sign: sign, signNew: signNew, fetch: &n, failing: fail, rotated: rotated, gate: gate,
		step: func(d time.Duration) { mu.Lock(); clock = clock.Add(d); mu.Unlock() },
		claim: func() map[string]any {
			c := now()
			return map[string]any{"iss": srv.URL + "/" + testRealmID, "sub": "u1", "aud": testAud, "iat": c.Unix(), "exp": c.Unix() + 3600}
		},
	}
}

func (e *windowEnv) verify(ctx context.Context) error {
	_, err := e.realm.Verify(ctx, e.sign(e.claim()), &VerifyOptions{Audience: testAud})
	return err
}

func TestVerify_CallerCancellationIsNotARealmAttempt(t *testing.T) {
	canceled := func() (context.Context, context.CancelFunc) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		return ctx, cancel
	}
	deadline := func() (context.Context, context.CancelFunc) {
		return context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	}
	for name, mk := range map[string]func() (context.Context, context.CancelFunc){"canceled": canceled, "deadline exceeded": deadline} {
		t.Run(name, func(t *testing.T) {
			e := newWindowEnv(t, false)
			// Cache a fresh set first: only then does an unknown kid reach the window.
			if err := e.verify(context.Background()); err != nil {
				t.Fatalf("first verify: %v", err)
			}
			e.step(6 * time.Second) // the first fetch's window is over; the set is still fresh
			ctx, cancel := mk()
			defer cancel()
			if _, err := e.realm.Verify(ctx, e.signNew(e.claim()), &VerifyOptions{Audience: testAud}); err == nil {
				t.Fatal("verify with a dead context succeeded")
			}
			// Let a (wrongly started) detached fetch finish and record its attempt.
			time.Sleep(50 * time.Millisecond)
			e.rotated.Store(true)
			e.step(time.Second) // inside the 5s window of any recorded attempt
			if _, err := e.realm.Verify(context.Background(), e.signNew(e.claim()), &VerifyOptions{Audience: testAud}); err != nil {
				t.Fatalf("the dead caller's cancellation was recorded as a refetch attempt, so the next caller was refused: %v", err)
			}
			if got := atomic.LoadInt32(e.fetch); got != 2 {
				t.Fatalf("fetches = %d, want 2 (the first, and the live caller's refetch)", got)
			}
		})
	}
}

func TestVerify_ExpiredSetRefetchIsNotGatedByTheWindow(t *testing.T) {
	e := newWindowEnv(t, false)
	if err := e.verify(context.Background()); err != nil {
		t.Fatalf("first verify: %v", err)
	}
	e.step(11 * time.Minute) // the set's TTL has passed
	e.failing.Store(true)
	if err := e.verify(context.Background()); err == nil {
		t.Fatal("verify against a failing JWKS succeeded")
	}
	e.step(time.Second)
	e.failing.Store(false)
	if err := e.verify(context.Background()); err != nil {
		t.Fatalf("an expired set's refetch was refused after one failed fetch: %v", err)
	}
}

func TestVerify_AbsentSetRefetchIsNotGatedByTheWindow(t *testing.T) {
	e := newWindowEnv(t, true)
	if err := e.verify(context.Background()); err == nil {
		t.Fatal("verify against a failing JWKS succeeded")
	}
	e.step(time.Second)
	e.failing.Store(false)
	if err := e.verify(context.Background()); err != nil {
		t.Fatalf("a first-ever fetch was refused after one failed fetch: %v", err)
	}
}

func TestVerify_ExpiredSetRefetchStaysSingleFlight(t *testing.T) {
	e := newWindowEnv(t, false)
	if err := e.verify(context.Background()); err != nil {
		t.Fatalf("first verify: %v", err)
	}
	e.step(11 * time.Minute)
	atomic.StoreInt32(e.fetch, 0)
	// Hold every fetch at the server until all callers are in, so they overlap.
	gate := make(chan struct{})
	e.gate.Store(&gate)
	var wg, started sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		started.Add(1)
		go func() {
			defer wg.Done()
			started.Done()
			if err := e.verify(context.Background()); err != nil {
				t.Errorf("verify: %v", err)
			}
		}()
	}
	started.Wait()
	time.Sleep(100 * time.Millisecond) // every caller is now at, or waiting on, the held fetch
	close(gate)
	wg.Wait()
	if got := atomic.LoadInt32(e.fetch); got != 1 {
		t.Fatalf("10 concurrent verifies on an expired set: %d fetches, want 1", got)
	}
}
