package realmid

// SPEC §4.2 — AuthClient.Token and the TokenManager refresh take the per-session
// refresh lock (go 0.64.2, owner ruling 2026-10-03).

import (
	"context"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

type tokRes struct {
	mr  *MintResult
	err error
}

func tokenAsync(e *rfEnv, rt string) chan tokRes {
	ch := make(chan tokRes, 1)
	go func() {
		mr, err := e.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: rt, TenantID: "t1"})
		ch <- tokRes{mr, err}
	}()
	return ch
}

func (e *rfEnv) seenTokens() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]string(nil), e.seen...)
}

func TestToken_ConcurrentCallsMintOnceAndLoserAdoptsTheWinner(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	e.gate = make(chan struct{})
	a := tokenAsync(e, "rt-old")
	waitFor(t, func() bool { return e.issuerCalls() == 1 })
	b := tokenAsync(e, "rt-old")
	time.Sleep(150 * time.Millisecond) // the loser reaches the lock and waits
	close(e.gate)
	ra, rb := <-a, <-b
	if ra.err != nil || rb.err != nil {
		t.Fatalf("errs: %v / %v", ra.err, rb.err)
	}
	if e.issuerCalls() != 1 {
		t.Fatalf("issuer minted %d times, want 1", e.issuerCalls())
	}
	if ra.mr.AccessToken != rb.mr.AccessToken || ra.mr.RefreshToken != "rt-new-1" || rb.mr.RefreshToken != "rt-new-1" {
		t.Fatalf("loser must get the winner's result: %+v vs %+v", ra.mr, rb.mr)
	}
}

// A request whose body differs (here: a narrower RolePermissions) must NOT adopt
// the winner's token minted for a different request; it retries on the rotated
// token instead.
func TestToken_DifferentRequestShapeRetriesOnTheRotatedToken(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	e.gate = make(chan struct{})
	a := tokenAsync(e, "rt-old")
	waitFor(t, func() bool { return e.issuerCalls() == 1 })
	b := make(chan tokRes, 1)
	go func() {
		mr, err := e.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: "rt-old", TenantID: "t1", RolePermissions: []string{}})
		b <- tokRes{mr, err}
	}()
	time.Sleep(150 * time.Millisecond)
	close(e.gate)
	ra, rb := <-a, <-b
	if ra.err != nil || rb.err != nil {
		t.Fatalf("errs: %v / %v", ra.err, rb.err)
	}
	seen := e.seenTokens()
	if len(seen) != 2 || seen[0] != "rt-old" || seen[1] != "rt-new-1" {
		t.Fatalf("issuer saw %v; the loser must re-present the ROTATED token, never rt-old", seen)
	}
	if rb.mr.RefreshToken != "rt-new-2" {
		t.Fatalf("loser result = %+v", rb.mr)
	}
}

// Token racing a direct MFAVerify on the same token: Token waits, then must not
// present the spent token; it mints on the one the verify rotated to.
func TestToken_RacingDirectMFAVerifyUsesTheRotatedToken(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	e.mfaGate = make(chan struct{})
	done := make(chan error, 1)
	go func() {
		_, err := e.realm.Auth.MFAVerify(context.Background(), MFAVerifyRequest{ChallengeToken: "c", Code: "1", RefreshToken: "rt-old"})
		done <- err
	}()
	waitFor(t, func() bool { e.mu.Lock(); defer e.mu.Unlock(); return e.mfaCalls == 1 })
	b := tokenAsync(e, "rt-old")
	time.Sleep(150 * time.Millisecond)
	if e.issuerCalls() != 0 {
		t.Fatal("Token must wait for the in-flight MFA verify")
	}
	close(e.mfaGate)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	rb := <-b
	if rb.err != nil {
		t.Fatalf("token: %v", rb.err)
	}
	if seen := e.seenTokens(); len(seen) != 1 || seen[0] != "rt-mfa-1" {
		t.Fatalf("issuer saw %v, want only the verify's rotated token", seen)
	}
}

func TestToken_StoresItsOutcomeBeforeReleasingAndLateRepeatReusesIt(t *testing.T) {
	st := &orderStore{MemorySessionStore: NewMemorySessionStore()}
	e := newRFEnv(t, rfOpts{store: st})
	if _, err := e.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: "rt-old", TenantID: "t1"}); err != nil {
		t.Fatal(err)
	}
	st.mu.Lock()
	early, rel := st.early, st.released
	st.mu.Unlock()
	if rel != 1 || early != 0 {
		t.Fatalf("released=%d beforeOutcome=%d", rel, early)
	}
	// a late repeat of the same request inside the window is answered from the outcome, never a second mint
	mr, err := e.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: "rt-old", TenantID: "t1"})
	if err != nil || mr.RefreshToken != "rt-new-1" || e.issuerCalls() != 1 {
		t.Fatalf("late repeat: %+v %v calls=%d", mr, err, e.issuerCalls())
	}
}

func TestToken_WinnerErrorIsSharedWithTheLoser(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	e.failAll = true
	e.gate = make(chan struct{})
	a := tokenAsync(e, "rt-old")
	waitFor(t, func() bool { return e.issuerCalls() == 1 })
	b := tokenAsync(e, "rt-old")
	time.Sleep(150 * time.Millisecond)
	close(e.gate)
	ra, rb := <-a, <-b
	if !IsCode(ra.err, ErrCodeRefreshInvalid) || !IsCode(rb.err, ErrCodeRefreshInvalid) || e.issuerCalls() != 1 {
		t.Fatalf("%v / %v calls=%d", ra.err, rb.err, e.issuerCalls())
	}
}

func TestToken_LockFailuresFailClosed(t *testing.T) {
	st := &lockErrStore{MemorySessionStore: NewMemorySessionStore()}
	e := newRFEnv(t, rfOpts{store: st})
	if _, err := e.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: "rt-old", TenantID: "t1"}); !IsCode(err, ErrCodeServerError) || e.issuerCalls() != 0 {
		t.Fatalf("store error: %v calls=%d", err, e.issuerCalls())
	}
	e2 := newRFEnv(t, rfOpts{})
	e2.realm.refreshSleep = func(time.Duration) {}
	_, _, _ = e2.store.AcquireRefreshLock(context.Background(), refreshLockKey("rt-old"), time.Hour)
	if _, err := e2.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: "rt-old", TenantID: "t1"}); !IsCode(err, ErrCodeServerError) || e2.issuerCalls() != 0 {
		t.Fatalf("held lock: %v calls=%d", err, e2.issuerCalls())
	}
}

func TestTokenManager_TwoManagersOnOneSessionMintOnce(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	e.gate = make(chan struct{})
	m1 := e.realm.Auth.NewTokenManager("rt-old")
	m2 := e.realm.Auth.NewTokenManager("rt-old")
	var wg sync.WaitGroup
	errs := make([]error, 2)
	run := func(i int, m *TokenManager) {
		wg.Add(1)
		go func() { defer wg.Done(); _, errs[i] = m.AccessToken(context.Background()) }()
	}
	run(0, m1)
	waitFor(t, func() bool { return e.issuerCalls() == 1 })
	run(1, m2)
	time.Sleep(150 * time.Millisecond)
	close(e.gate)
	wg.Wait()
	if errs[0] != nil || errs[1] != nil || e.issuerCalls() != 1 {
		t.Fatalf("errs=%v calls=%d", errs, e.issuerCalls())
	}
}

// Nothing that already holds the lock may take it again (it is not re-entrant).
func TestToken_InternalCallersNeverDoubleLock(t *testing.T) {
	prh := func(context.Context, string, string) ([]string, error) { return []string{"dispatch"}, nil }

	t.Run("middleware refresh route + derived-claims re-mint", func(t *testing.T) {
		st := &lockCountStore{MemorySessionStore: NewMemorySessionStore()}
		e := newRFEnv(t, rfOpts{store: st})
		e.realm.cfg.ProductRoles = prh
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() { done <- e.post("/token", "rt-old", `{"tenant_id":"t1"}`) }()
		select {
		case w := <-done:
			if w.Code != 200 {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
		case <-time.After(2 * time.Second):
			t.Fatal("deadlock: the refresh route re-took its own lock")
		}
		if n := st.acquires.Load(); n != 1 {
			t.Fatalf("acquires = %d, want 1", n)
		}
	})

	t.Run("direct MFAVerify + post-verify mint", func(t *testing.T) {
		st := &lockCountStore{MemorySessionStore: NewMemorySessionStore()}
		e := newRFEnv(t, rfOpts{store: st})
		e.mfaTenant = "t1"
		e.realm.cfg.ProductRoles = prh
		done := make(chan error, 1)
		go func() {
			_, err := e.realm.Auth.MFAVerify(context.Background(), MFAVerifyRequest{ChallengeToken: "c", Code: "1", RefreshToken: "rt-old"})
			done <- err
		}()
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("deadlock: the post-verify mint re-took a lock")
		}
		if n := st.acquires.Load(); n != 1 {
			t.Fatalf("acquires = %d, want 1 (the outer lock only)", n)
		}
	})
}
