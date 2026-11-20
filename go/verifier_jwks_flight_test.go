package realmid

// SPEC §2 — callers that need a JWKS fetch share ONE in-flight fetch and receive
// its outcome; the fetch is bounded by the SDK's own timeout, never by one
// caller's context.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type flightEnv struct {
	realm   *Realm
	sign    func(map[string]any) string
	claim   func() map[string]any
	fetches *int32
	started chan struct{} // one send per request that reaches the server
	release chan struct{} // closed to let blocked requests answer
	failing *atomic.Bool
	step    func(d time.Duration)
}

func newFlightEnv(t *testing.T, hc *http.Client) *flightEnv {
	t.Helper()
	sign, key := mintKey(t, "kid-known")
	e := &flightEnv{sign: sign, fetches: new(int32), started: make(chan struct{}, 64), release: make(chan struct{}), failing: &atomic.Bool{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(e.fetches, 1)
		e.started <- struct{}{}
		select {
		case <-e.release:
		case <-r.Context().Done():
			return
		}
		if e.failing.Load() {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(jwksDoc{Keys: []jwk{key}})
	}))
	t.Cleanup(srv.Close)
	clock := time.Now()
	var mu sync.Mutex
	now := func() time.Time { mu.Lock(); defer mu.Unlock(); return clock }
	e.step = func(d time.Duration) { mu.Lock(); clock = clock.Add(d); mu.Unlock() }
	r, err := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk_live_test", BaseURL: srv.URL, Clock: now, HTTPClient: hc})
	if err != nil {
		t.Fatalf("NewRealm: %v", err)
	}
	e.realm = r
	e.claim = func() map[string]any {
		c := now()
		return map[string]any{"iss": srv.URL + "/" + testRealmID, "sub": "u1", "aud": testAud, "iat": c.Unix(), "exp": c.Unix() + 3600}
	}
	return e
}

func (e *flightEnv) verify(ctx context.Context) error {
	_, err := e.realm.Verify(ctx, e.sign(e.claim()), &VerifyOptions{Audience: testAud})
	return err
}

// launch starts n callers and returns a channel of their results.
func (e *flightEnv) launch(ctx context.Context, n int) chan error {
	out := make(chan error, n)
	for i := 0; i < n; i++ {
		go func() { out <- e.verify(ctx) }()
	}
	return out
}

func (e *flightEnv) waitStarted(t *testing.T) {
	t.Helper()
	select {
	case <-e.started:
	case <-time.After(5 * time.Second):
		t.Fatal("no fetch reached the server")
	}
}

func recv(t *testing.T, ch chan error) error {
	t.Helper()
	select {
	case err := <-ch:
		return err
	case <-time.After(10 * time.Second):
		t.Fatal("caller did not return")
		return nil
	}
}

func fetchCount(e *flightEnv) int32 { return atomic.LoadInt32(e.fetches) }

func TestJWKSFlight_ConcurrentCallersShareOneFetch(t *testing.T) {
	e := newFlightEnv(t, nil)
	const n = 8
	out := e.launch(context.Background(), n)
	e.waitStarted(t)
	time.Sleep(100 * time.Millisecond) // let the others join the flight
	close(e.release)
	for i := 0; i < n; i++ {
		if err := recv(t, out); err != nil {
			t.Fatalf("caller %d: %v", i, err)
		}
	}
	if got := fetchCount(e); got != 1 {
		t.Fatalf("fetches = %d, want 1", got)
	}
}

func TestJWKSFlight_FailureIsSharedAndNotRetriedInWindow(t *testing.T) {
	e := newFlightEnv(t, nil)
	e.failing.Store(true)
	const n = 6
	out := e.launch(context.Background(), n)
	e.waitStarted(t)
	time.Sleep(100 * time.Millisecond)
	close(e.release)
	for i := 0; i < n; i++ {
		var re *RealmError
		if err := recv(t, out); !errors.As(err, &re) || re.Code != ErrCodeJWKSFetchFailed {
			t.Fatalf("caller %d: err = %v, want jwks_fetch_failed", i, err)
		}
	}
	if got := fetchCount(e); got != 1 {
		t.Fatalf("fetches = %d, want 1", got)
	}
}

func TestJWKSFlight_LeaderCancelDoesNotFailWaiters(t *testing.T) {
	e := newFlightEnv(t, nil)
	lctx, cancel := context.WithCancel(context.Background())
	leader := e.launch(lctx, 1)
	e.waitStarted(t)
	others := e.launch(context.Background(), 4)
	time.Sleep(100 * time.Millisecond)
	cancel()
	if err := recv(t, leader); !errors.Is(err, context.Canceled) {
		t.Fatalf("leader err = %v, want context.Canceled", err)
	}
	close(e.release)
	for i := 0; i < 4; i++ {
		if err := recv(t, others); err != nil {
			t.Fatalf("waiter %d: %v", i, err)
		}
	}
	if got := fetchCount(e); got != 1 {
		t.Fatalf("fetches = %d, want 1", got)
	}
}

func TestJWKSFlight_OwnCancelReturnsOnlyThatCaller(t *testing.T) {
	e := newFlightEnv(t, nil)
	first := e.launch(context.Background(), 1)
	e.waitStarted(t)
	cctx, cancel := context.WithCancel(context.Background())
	canceled := e.launch(cctx, 1)
	time.Sleep(100 * time.Millisecond)
	cancel()
	if err := recv(t, canceled); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled caller err = %v, want context.Canceled", err)
	}
	close(e.release)
	if err := recv(t, first); err != nil {
		t.Fatalf("other caller: %v", err)
	}
	if got := fetchCount(e); got != 1 {
		t.Fatalf("fetches = %d, want 1", got)
	}
}

func TestJWKSFlight_CanceledBeforeAnyFetchStartsNothing(t *testing.T) {
	e := newFlightEnv(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := e.verify(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if got := fetchCount(e); got != 0 {
		t.Fatalf("fetches = %d, want 0", got)
	}
}

func TestJWKSFlight_FreshFetchAfterWindow(t *testing.T) {
	e := newFlightEnv(t, nil)
	close(e.release)
	if err := e.verify(context.Background()); err != nil {
		t.Fatalf("first verify: %v", err)
	}
	other, _ := mintKey(t, "kid-other")
	verifyOther := func() error {
		_, err := e.realm.Verify(context.Background(), other(e.claim()), &VerifyOptions{Audience: testAud})
		return err
	}
	var re *RealmError
	// inside the window of the first fetch: the last answer, no new fetch
	e.step(2 * time.Second)
	before := fetchCount(e)
	if err := verifyOther(); !errors.As(err, &re) || re.Code != ErrCodeUnknownKID {
		t.Fatalf("err = %v, want unknown_kid", err)
	}
	if got := fetchCount(e); got != before {
		t.Fatalf("fetch inside the window: %d, want %d", got, before)
	}
	// past the window: one fresh fetch
	e.step(4 * time.Second)
	if err := verifyOther(); !errors.As(err, &re) || re.Code != ErrCodeUnknownKID {
		t.Fatalf("err = %v, want unknown_kid", err)
	}
	if got := fetchCount(e); got != before+1 {
		t.Fatalf("fetches = %d, want %d (fresh fetch after window)", got, before+1)
	}
}

func TestJWKSFlight_UnknownKidRefetchOfFreshSetIsShared(t *testing.T) {
	e := newFlightEnv(t, nil)
	close(e.release)
	if err := e.verify(context.Background()); err != nil {
		t.Fatalf("first verify: %v", err)
	}
	<-e.started             // the first fetch's token
	e.step(6 * time.Second) // window over, set still fresh
	other, _ := mintKey(t, "kid-other")
	before := fetchCount(e)
	e.release = make(chan struct{}) // the next fetch blocks until released
	out := make(chan error, 5)
	for i := 0; i < 5; i++ {
		go func() {
			_, err := e.realm.Verify(context.Background(), other(e.claim()), &VerifyOptions{Audience: testAud})
			out <- err
		}()
	}
	e.waitStarted(t)
	time.Sleep(100 * time.Millisecond)
	close(e.release)
	for i := 0; i < 5; i++ {
		var re *RealmError
		if err := recv(t, out); !errors.As(err, &re) || re.Code != ErrCodeUnknownKID {
			t.Fatalf("caller %d: err = %v, want unknown_kid", i, err)
		}
	}
	if got := fetchCount(e); got != before+1 {
		t.Fatalf("fetches = %d, want %d", got, before+1)
	}
}

func TestJWKSFlight_ClientWithoutTimeoutIsStillBounded(t *testing.T) {
	e := newFlightEnv(t, &http.Client{})
	e.realm.verifier.fetchCap = 200 * time.Millisecond
	// the server never answers (release stays open); the fetch must end by itself
	start := time.Now()
	err := e.verify(context.Background())
	var re *RealmError
	if !errors.As(err, &re) || re.Code != ErrCodeJWKSFetchFailed {
		t.Fatalf("err = %v, want jwks_fetch_failed", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatalf("fetch took %v", time.Since(start))
	}
}

type panicOnce struct {
	next http.RoundTripper
	boom atomic.Bool
}

func (p *panicOnce) RoundTrip(r *http.Request) (*http.Response, error) {
	if p.boom.Load() {
		panic("simulated fetch panic")
	}
	return p.next.RoundTrip(r)
}

// A panic inside the detached fetch must not kill the process or strand the flight.
func TestJWKSFlight_PanicBecomesTheFlightError(t *testing.T) {
	rt := &panicOnce{next: http.DefaultTransport}
	rt.boom.Store(true)
	e := newFlightEnv(t, &http.Client{Transport: rt})
	close(e.release)
	err := e.verify(context.Background())
	var re *RealmError
	if !errors.As(err, &re) || re.Code != ErrCodeJWKSFetchFailed {
		t.Fatalf("verify = %v, want a jwks_fetch_failed RealmError", err)
	}
	e.step(6 * time.Second)
	rt.boom.Store(false)
	if err := e.verify(context.Background()); err != nil {
		t.Fatalf("verify after the panic: %v", err)
	}
}
