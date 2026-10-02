package realmid

// SPEC §10.1 step 4a / step 5 — per-session refresh single-flight.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type rfEnv struct {
	srv   *httptest.Server
	realm *Realm
	h     http.Handler
	store *MemorySessionStore
	sign  signFn

	mu       sync.Mutex
	calls    int
	seen     []string        // refresh tokens presented to /auth/token
	spent    map[string]bool // reuse detector
	gate     chan struct{}   // when non-nil, /auth/token blocks until closed
	failAll  bool
	mfaCalls int
	recCalls int                       // /auth/mfa/recovery
	onToken  func(body map[string]any) // optional: sees each /auth/token body
}

type rfOpts struct {
	opts  MiddlewareOptions
	store SessionStateStore
}

func newRFEnv(t *testing.T, o rfOpts) *rfEnv {
	t.Helper()
	sign, key := mintTestKey(t, "k1")
	e := &rfEnv{sign: sign, spent: map[string]bool{}, store: NewMemorySessionStore()}
	e.srv = mwTestServer(t, []jwk{key}, testAud, map[string]http.HandlerFunc{
		"/auth/token": func(w http.ResponseWriter, r *http.Request) {
			b, _ := io.ReadAll(r.Body)
			var body map[string]any
			_ = json.Unmarshal(b, &body)
			rt, _ := body["refresh_token"].(string)
			tenant, _ := body["tenant_id"].(string)
			e.mu.Lock()
			e.calls++
			n := e.calls
			e.seen = append(e.seen, rt)
			gate := e.gate
			reused := e.spent[rt]
			e.spent[rt] = true
			fail := e.failAll
			if e.onToken != nil {
				e.onToken(body)
			}
			e.mu.Unlock()
			if gate != nil {
				select {
				case <-gate:
				case <-r.Context().Done():
					return
				}
			}
			if fail {
				w.WriteHeader(401)
				_, _ = w.Write([]byte(`{"error":{"code":"refresh_invalid","message":"nope"}}`))
				return
			}
			if reused {
				w.WriteHeader(401)
				_, _ = w.Write([]byte(`{"error":{"code":"refresh_reused","message":"reuse"}}`))
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":  e.mint(tenant, n),
				"refresh_token": fmt.Sprintf("rt-new-%d", n),
				"expires_in":    900, "tenant_id": tenant, "role": "member",
			})
		},
		"/auth/mfa/recovery": func(w http.ResponseWriter, r *http.Request) {
			e.mu.Lock()
			e.recCalls++
			n := e.recCalls
			e.mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": e.mint("t1", 200+n), "refresh_token": fmt.Sprintf("rt-rec-%d", n),
				"expires_in": 900, "reenroll_required": true,
			})
		},
		"/auth/mfa/verify": func(w http.ResponseWriter, r *http.Request) {
			e.mu.Lock()
			e.mfaCalls++
			n := e.mfaCalls
			e.mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status": "ok", "access_token": e.mint("t1", 100+n), "refresh_token": fmt.Sprintf("rt-mfa-%d", n),
				"expires_in": 900,
			})
		},
	})
	t.Cleanup(e.srv.Close)
	store := o.store
	if store == nil {
		store = e.store
	}
	r, err := NewRealm(Config{SessionStore: store, RealmID: testRealmID, APIKey: "k", BaseURL: e.srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	e.realm = r
	e.h = r.Middleware(o.opts)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	return e
}

func (e *rfEnv) mint(tenant string, n int) string {
	return e.sign(baseClaims(e.srv.URL, func(c map[string]any) {
		c["sid"] = "S1"
		c["sub"] = "sub-" + tenant
		c["jti"] = fmt.Sprintf("j%d", n)
	}))
}

func (e *rfEnv) post(path, cookie, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", path, strings.NewReader(body))
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: "realmid_refresh", Value: cookie})
	}
	w := httptest.NewRecorder()
	e.h.ServeHTTP(w, req)
	return w
}

func (e *rfEnv) issuerCalls() int { e.mu.Lock(); defer e.mu.Unlock(); return e.calls }

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	for i := 0; i < 400; i++ {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition never held")
}

func setCookie(w *httptest.ResponseRecorder) string {
	for _, c := range w.Result().Cookies() {
		if c.Name == "realmid_refresh" {
			return c.Value
		}
	}
	return ""
}

// race runs the same-time requests against one gated mint and returns responses.
func (e *rfEnv) race(t *testing.T, bodies []string, cookie string) []*httptest.ResponseRecorder {
	t.Helper()
	e.gate = make(chan struct{})
	out := make([]*httptest.ResponseRecorder, len(bodies))
	var wg sync.WaitGroup
	for i, b := range bodies {
		i, b := i, b
		wg.Add(1)
		go func() { defer wg.Done(); out[i] = e.post("/token", cookie, b) }()
		if i == 0 {
			waitFor(t, func() bool { return e.issuerCalls() == 1 })
		}
	}
	time.Sleep(150 * time.Millisecond) // let the losers reach the lock
	close(e.gate)
	wg.Wait()
	return out
}

func TestSPEC10_1_4a_SameTenantRaceMintsOnce(t *testing.T) {
	for _, n := range []int{2, 10} {
		e := newRFEnv(t, rfOpts{})
		bodies := make([]string, n)
		for i := range bodies {
			bodies[i] = `{"tenant_id":"t1"}`
		}
		rs := e.race(t, bodies, "rt-old")
		if e.issuerCalls() != 1 {
			t.Fatalf("n=%d: issuer called %d times", n, e.issuerCalls())
		}
		var first map[string]any
		for i, w := range rs {
			if w.Code != 200 {
				t.Fatalf("n=%d resp %d: %d %s", n, i, w.Code, w.Body.String())
			}
			var b map[string]any
			_ = json.Unmarshal(w.Body.Bytes(), &b)
			if i == 0 {
				first = b
			} else if b["access_token"] != first["access_token"] || setCookie(w) != setCookie(rs[0]) || setCookie(w) == "" {
				t.Fatalf("n=%d resp %d differs from winner", n, i)
			}
		}
	}
}

func TestSPEC10_1_4a_WinnerErrorIsSharedAndIssuerCalledOnce(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	e.failAll = true
	rs := e.race(t, []string{`{"tenant_id":"t1"}`, `{"tenant_id":"t1"}`}, "rt-old")
	if e.issuerCalls() != 1 {
		t.Fatalf("calls %d", e.issuerCalls())
	}
	if rs[0].Code != 401 || rs[1].Code != 401 || rs[0].Body.String() != rs[1].Body.String() {
		t.Fatalf("%d %s | %d %s", rs[0].Code, rs[0].Body.String(), rs[1].Code, rs[1].Body.String())
	}
}

func TestSPEC10_1_4a_DifferentTenantLoserGets503RetryWithRotatedToken(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	rs := e.race(t, []string{`{"tenant_id":"t1"}`, `{"tenant_id":"t2"}`}, "rt-old")
	if e.issuerCalls() != 1 {
		t.Fatalf("calls %d", e.issuerCalls())
	}
	win, lose := rs[0], rs[1]
	if win.Code != 200 || lose.Code != 503 {
		t.Fatalf("%d / %d %s", win.Code, lose.Code, lose.Body.String())
	}
	var b struct {
		Error struct{ Code, Message string }
		Retry bool
	}
	_ = json.Unmarshal(lose.Body.Bytes(), &b)
	if b.Error.Code != "server_error" || b.Error.Message != "refresh superseded, retry" || !b.Retry {
		t.Fatalf("body %s", lose.Body.String())
	}
	if setCookie(lose) == "" || setCookie(lose) != setCookie(win) {
		t.Fatalf("loser must hand over the winner's token: %q vs %q", setCookie(lose), setCookie(win))
	}
	// the client's retry uses the NEW token and is for the loser's tenant
	w := e.post("/token", setCookie(lose), `{"tenant_id":"t2"}`)
	if w.Code != 200 {
		t.Fatalf("retry %d %s", w.Code, w.Body.String())
	}
	e.mu.Lock()
	last := e.seen[len(e.seen)-1]
	e.mu.Unlock()
	if last != setCookie(win) {
		t.Fatalf("retry presented %q", last)
	}
}

func TestSPEC10_1_4a_BodyMode503CarriesRefreshToken(t *testing.T) {
	e := newRFEnv(t, rfOpts{opts: MiddlewareOptions{TokenDelivery: "body"}})
	e.gate = make(chan struct{})
	var wg sync.WaitGroup
	var win, lose *httptest.ResponseRecorder
	wg.Add(2)
	go func() { defer wg.Done(); win = e.post("/token", "", `{"refresh_token":"rt-old","tenant_id":"t1"}`) }()
	waitFor(t, func() bool { return e.issuerCalls() == 1 })
	go func() { defer wg.Done(); lose = e.post("/token", "", `{"refresh_token":"rt-old","tenant_id":"t2"}`) }()
	time.Sleep(150 * time.Millisecond)
	close(e.gate)
	wg.Wait()
	var wb, lb map[string]any
	_ = json.Unmarshal(win.Body.Bytes(), &wb)
	_ = json.Unmarshal(lose.Body.Bytes(), &lb)
	if win.Code != 200 || lose.Code != 503 || lb["refresh_token"] == nil || lb["refresh_token"] != wb["refresh_token"] {
		t.Fatalf("%d %v / %d %v", win.Code, wb, lose.Code, lb)
	}
}

func TestSPEC10_1_4a_DifferentCustomClaimsIsTheSameBranch(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	rs := e.race(t, []string{`{"tenant_id":"t1","custom_claims":{"a":1}}`, `{"tenant_id":"t1","custom_claims":{"a":2}}`}, "rt-old")
	if rs[0].Code != 200 || rs[1].Code != 503 || e.issuerCalls() != 1 {
		t.Fatalf("%d %d calls=%d", rs[0].Code, rs[1].Code, e.issuerCalls())
	}
}

func TestSPEC10_1_4a_SequentialRepeatWithinWindowReusesOutcome_ThenWindowCloses(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	now := time.Now()
	e.store.now = func() time.Time { return now }
	w1 := e.post("/token", "rt-old", `{"tenant_id":"t1"}`)
	w2 := e.post("/token", "rt-old", `{"tenant_id":"t1"}`) // lost response / reload
	if w1.Code != 200 || w2.Code != 200 || e.issuerCalls() != 1 || setCookie(w2) != setCookie(w1) {
		t.Fatalf("%d %d calls=%d", w1.Code, w2.Code, e.issuerCalls())
	}
	now = now.Add(6 * time.Second)
	w3 := e.post("/token", "rt-old", `{"tenant_id":"t1"}`)
	if e.issuerCalls() != 2 || w3.Code != 401 || !strings.Contains(w3.Body.String(), "refresh_reused") {
		t.Fatalf("after the window the issuer is called (and reuse surfaces): %d %s calls=%d", w3.Code, w3.Body.String(), e.issuerCalls())
	}
	// lock released after failure too: a fourth request acquires immediately
	if w4 := e.post("/token", "rt-other", `{"tenant_id":"t1"}`); w4.Code != 200 {
		t.Fatalf("lock not released: %d %s", w4.Code, w4.Body.String())
	}
}

func TestSPEC10_1_4a_LockHeldElsewhereTimesOutWith503NoMint(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	e.realm.refreshSleep = func(time.Duration) {}
	ok, _, _ := e.store.AcquireRefreshLock(context.Background(), refreshLockKey("rt-old"), time.Hour)
	if !ok {
		t.Fatal("setup")
	}
	w := e.post("/token", "rt-old", `{"tenant_id":"t1"}`)
	if w.Code != 503 || !strings.Contains(w.Body.String(), "refresh in progress") || e.issuerCalls() != 0 {
		t.Fatalf("%d %s calls=%d", w.Code, w.Body.String(), e.issuerCalls())
	}
}

type lockErrStore struct {
	*MemorySessionStore
	acquires atomic.Int32
}

func (s *lockErrStore) AcquireRefreshLock(context.Context, string, time.Duration) (bool, func(context.Context) error, error) {
	s.acquires.Add(1)
	return false, nil, errors.New("redis down")
}

func TestSPEC10_1_4a_StoreErrorOnAcquireIs503NoMint(t *testing.T) {
	st := &lockErrStore{MemorySessionStore: NewMemorySessionStore()}
	e := newRFEnv(t, rfOpts{store: st})
	w := e.post("/token", "rt-old", `{"tenant_id":"t1"}`)
	if w.Code != 503 || !strings.Contains(w.Body.String(), "session store unavailable") || e.issuerCalls() != 0 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}

func TestSPEC10_1_4a_KeyIsTheFirstCandidate(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	req := httptest.NewRequest("POST", "/token", strings.NewReader(`{"tenant_id":"t1"}`))
	req.AddCookie(&http.Cookie{Name: "realmid_refresh", Value: "first"})
	req.AddCookie(&http.Cookie{Name: "realmid_refresh", Value: "second"})
	e.h.ServeHTTP(httptest.NewRecorder(), req)
	if _, ok, _ := e.store.GetRefreshResult(context.Background(), refreshOutcomeKey("first")); !ok {
		t.Fatal("outcome must be stored under the first candidate's key")
	}
}

func TestSPEC10_1_4a_ClientCancelDoesNotAbortTheMint(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	e.gate = make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest("POST", "/token", strings.NewReader(`{"tenant_id":"t1"}`)).WithContext(ctx)
	req.AddCookie(&http.Cookie{Name: "realmid_refresh", Value: "rt-old"})
	done := make(chan struct{})
	go func() { e.h.ServeHTTP(httptest.NewRecorder(), req); close(done) }()
	waitFor(t, func() bool { return e.issuerCalls() == 1 })
	cancel()
	close(e.gate)
	<-done
	w := e.post("/token", "rt-old", `{"tenant_id":"t1"}`)
	if w.Code != 200 || e.issuerCalls() != 1 {
		t.Fatalf("retry within the window must get the stored outcome: %d %s calls=%d", w.Code, w.Body.String(), e.issuerCalls())
	}
}

func TestSPEC10_1_4a_MintIsBoundedAndErrorStored(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	e.realm.refreshMintTimeout = 200 * time.Millisecond
	e.gate = make(chan struct{}) // never opened: the issuer hangs
	w := e.post("/token", "rt-old", `{"tenant_id":"t1"}`)
	if w.Code == 200 {
		t.Fatal("hung mint must fail")
	}
	if _, ok, _ := e.store.GetRefreshResult(context.Background(), refreshOutcomeKey("rt-old")); !ok {
		t.Fatal("error outcome must be stored")
	}
	ok, rel, _ := e.store.AcquireRefreshLock(context.Background(), refreshLockKey("rt-old"), time.Second)
	if !ok {
		t.Fatal("lock must be released")
	}
	_ = rel(context.Background())
}

func TestSPEC10_1_4a_OnAuthSuccessRunsForTheLoserAndItsErrorIsTheLosersOnly(t *testing.T) {
	var hooks atomic.Int32
	fail := atomic.Bool{}
	opts := MiddlewareOptions{OnAuthSuccess: func(_ context.Context, ev *AuthSuccessEvent) error {
		hooks.Add(1)
		if fail.Load() && ev.Request.Header.Get("X-Loser") == "1" {
			return errors.New("hook says no")
		}
		return nil
	}}
	e := newRFEnv(t, rfOpts{opts: opts})
	fail.Store(true)
	e.gate = make(chan struct{})
	var wg sync.WaitGroup
	var win, lose *httptest.ResponseRecorder
	wg.Add(2)
	go func() { defer wg.Done(); win = e.post("/token", "rt-old", `{"tenant_id":"t1"}`) }()
	waitFor(t, func() bool { return e.issuerCalls() == 1 })
	go func() {
		defer wg.Done()
		req := httptest.NewRequest("POST", "/token", strings.NewReader(`{"tenant_id":"t1"}`))
		req.Header.Set("X-Loser", "1")
		req.AddCookie(&http.Cookie{Name: "realmid_refresh", Value: "rt-old"})
		lose = httptest.NewRecorder()
		e.h.ServeHTTP(lose, req)
	}()
	time.Sleep(150 * time.Millisecond)
	close(e.gate)
	wg.Wait()
	if win.Code != 200 || lose.Code == 200 || hooks.Load() != 2 {
		t.Fatalf("win=%d lose=%d hooks=%d", win.Code, lose.Code, hooks.Load())
	}
}

// --- MFA verify under the lock (step 5) ---

func TestSPEC10_1_5_MFAVerifyWithoutRefreshCandidateTakesNoLock(t *testing.T) {
	st := &lockErrStore{MemorySessionStore: NewMemorySessionStore()}
	e := newRFEnv(t, rfOpts{store: st})
	e.post("/mfa/verify", "", `{"challenge_token":"c","code":"1"}`)
	if st.acquires.Load() != 0 {
		t.Fatal("first-login MFA must not take the lock")
	}
}

func TestSPEC10_1_5_MFAVerifyWaitsForTheLockThenCallsIssuerOnce(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	ok, rel, _ := e.store.AcquireRefreshLock(context.Background(), refreshLockKey("rt-old"), time.Hour)
	if !ok {
		t.Fatal("setup")
	}
	done := make(chan *httptest.ResponseRecorder)
	go func() { done <- e.post("/mfa/verify", "rt-old", `{"challenge_token":"c","code":"1"}`) }()
	time.Sleep(200 * time.Millisecond)
	e.mu.Lock()
	early := e.mfaCalls
	e.mu.Unlock()
	if early != 0 {
		t.Fatal("must wait for the lock before calling the issuer")
	}
	_ = rel(context.Background())
	w := <-done
	e.mu.Lock()
	n := e.mfaCalls
	e.mu.Unlock()
	if w.Code != 200 || n != 1 {
		t.Fatalf("%d calls=%d %s", w.Code, n, w.Body.String())
	}
	// its outcome (fingerprint mfa-verify) is stored under the key
	if _, ok, _ := e.store.GetRefreshResult(context.Background(), refreshOutcomeKey("rt-old")); !ok {
		t.Fatal("mfa-verify must store its outcome")
	}
}

func TestSPEC10_1_5_MFAVerifyWaitingTooLongIs503AndIssuerNotCalled(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	e.realm.refreshSleep = func(time.Duration) {}
	_, _, _ = e.store.AcquireRefreshLock(context.Background(), refreshLockKey("rt-old"), time.Hour)
	w := e.post("/mfa/verify", "rt-old", `{"challenge_token":"c","code":"1"}`)
	if w.Code != 503 || !strings.Contains(w.Body.String(), "refresh in progress") || e.mfaCalls != 0 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}

func TestSPEC10_1_5_RefreshLoserBehindMFAVerifyGets503WithRotatedToken(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	// MFA-verify winner has finished: its outcome sits under the key, lock still held
	ok, _, _ := e.store.AcquireRefreshLock(context.Background(), refreshLockKey("rt-old"), time.Hour)
	if !ok {
		t.Fatal("setup")
	}
	out, _ := json.Marshal(refreshOutcome{Fingerprint: "mfa-verify", Mint: &MintResult{RefreshToken: "rt-mfa-1"}})
	_ = e.store.PutRefreshResult(context.Background(), refreshOutcomeKey("rt-old"), out, 5*time.Second)
	w := e.post("/token", "rt-old", `{"tenant_id":"t1"}`)
	if w.Code != 503 || setCookie(w) != "rt-mfa-1" || !strings.Contains(w.Body.String(), `"retry":true`) || e.issuerCalls() != 0 {
		t.Fatalf("%d %s cookie=%q", w.Code, w.Body.String(), setCookie(w))
	}
}
