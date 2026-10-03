package realmid

// SPEC §4.3 / §4.3a / §10.1 steps 5, 5a — a DIRECT AuthClient.MFAVerify /
// RedeemRecoveryCode call can opt into the per-session refresh lock by passing
// the session's current refresh token (go 0.64.2, OQ-7 option (a)).

import (
	"context"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type directCall struct {
	name   string
	calls  func(e *rfEnv) int
	invoke func(e *rfEnv, refresh string) (*Session, error)
	rotate string // refresh token the issuer rotates to on the first call
}

func directCalls() []directCall {
	return []directCall{
		{"MFAVerify", func(e *rfEnv) int { e.mu.Lock(); defer e.mu.Unlock(); return e.mfaCalls },
			func(e *rfEnv, rt string) (*Session, error) {
				return e.realm.Auth.MFAVerify(context.Background(), MFAVerifyRequest{ChallengeToken: "c", Code: "1", RefreshToken: rt})
			}, "rt-mfa-1"},
		{"MFAVerifyOTP", func(e *rfEnv) int { e.mu.Lock(); defer e.mu.Unlock(); return e.mfaCalls },
			func(e *rfEnv, rt string) (*Session, error) {
				return e.realm.Auth.MFAVerifyOTP(context.Background(), MFAVerifyOTPRequest{MFAToken: "c", Presented: "1", RefreshToken: rt})
			}, "rt-mfa-1"},
		{"RedeemRecoveryCode", func(e *rfEnv) int { e.mu.Lock(); defer e.mu.Unlock(); return e.recCalls },
			func(e *rfEnv, rt string) (*Session, error) {
				return e.realm.Auth.RedeemRecoveryCode(context.Background(), RedeemRecoveryCodeRequest{ChallengeToken: "c", Code: "abcd-efgh", RefreshToken: rt})
			}, "rt-rec-1"},
	}
}

func TestDirectMFA_RefreshLockSerializesAgainstMiddlewareRefresh(t *testing.T) {
	for _, dc := range directCalls() {
		dc := dc
		t.Run(dc.name, func(t *testing.T) {
			e := newRFEnv(t, rfOpts{})
			e.mfaGate = make(chan struct{})
			done := make(chan error, 1)
			go func() { _, err := dc.invoke(e, "rt-old"); done <- err }()
			waitFor(t, func() bool { return dc.calls(e) == 1 }) // direct call is in flight, holding the lock
			refresh := make(chan *httptest.ResponseRecorder, 1)
			go func() { refresh <- e.post("/token", "rt-old", `{"tenant_id":"t1"}`) }()
			time.Sleep(150 * time.Millisecond) // the refresh reaches the lock and waits
			close(e.mfaGate)
			if err := <-done; err != nil {
				t.Fatalf("direct call: %v", err)
			}
			w := <-refresh
			if w.Code != 503 || setCookie(w) != dc.rotate || !strings.Contains(w.Body.String(), `"retry":true`) {
				t.Fatalf("refresh must adopt the rotated token: %d %s cookie=%q", w.Code, w.Body.String(), setCookie(w))
			}
			if e.issuerCalls() != 0 {
				t.Fatalf("refresh re-presented the old token to the issuer %d times", e.issuerCalls())
			}
		})
	}
}

func TestDirectMFA_StoresOutcomeAndReleasesLock(t *testing.T) {
	for _, dc := range directCalls() {
		dc := dc
		t.Run(dc.name, func(t *testing.T) {
			e := newRFEnv(t, rfOpts{})
			if _, err := dc.invoke(e, "rt-old"); err != nil {
				t.Fatal(err)
			}
			raw, ok, _ := e.store.GetRefreshResult(context.Background(), refreshOutcomeKey("rt-old"))
			if !ok || !strings.Contains(string(raw), `"fp":"mfa-verify"`) || !strings.Contains(string(raw), dc.rotate) {
				t.Fatalf("outcome = %q ok=%v", raw, ok)
			}
			got, rel, err := e.store.AcquireRefreshLock(context.Background(), refreshLockKey("rt-old"), time.Hour)
			if err != nil || !got {
				t.Fatalf("lock not released: %v %v", got, err)
			}
			_ = rel(context.Background())
		})
	}
}

func TestDirectMFA_EmptyRefreshTokenTakesNoLock(t *testing.T) {
	for _, dc := range directCalls() {
		dc := dc
		t.Run(dc.name, func(t *testing.T) {
			st := &lockErrStore{MemorySessionStore: NewMemorySessionStore()}
			e := newRFEnv(t, rfOpts{store: st})
			if _, err := dc.invoke(e, ""); err != nil {
				t.Fatal(err)
			}
			if st.acquires.Load() != 0 || dc.calls(e) != 1 {
				t.Fatalf("acquires=%d issuer=%d", st.acquires.Load(), dc.calls(e))
			}
		})
	}
}

func TestDirectMFA_LockHeldPastWaitsIs503AndIssuerNotCalled(t *testing.T) {
	for _, dc := range directCalls() {
		dc := dc
		t.Run(dc.name, func(t *testing.T) {
			e := newRFEnv(t, rfOpts{})
			e.realm.refreshSleep = func(time.Duration) {}
			_, _, _ = e.store.AcquireRefreshLock(context.Background(), refreshLockKey("rt-old"), time.Hour)
			_, err := dc.invoke(e, "rt-old")
			if !IsCode(err, ErrCodeServerError) || !strings.Contains(err.Error(), "refresh in progress") || !strings.Contains(err.Error(), "503") {
				t.Fatalf("err = %v", err)
			}
			if dc.calls(e) != 0 {
				t.Fatal("issuer must not be called")
			}
		})
	}
}

func TestDirectMFA_StoreErrorOnAcquireIsErrorAndIssuerNotCalled(t *testing.T) {
	for _, dc := range directCalls() {
		dc := dc
		t.Run(dc.name, func(t *testing.T) {
			st := &lockErrStore{MemorySessionStore: NewMemorySessionStore()}
			e := newRFEnv(t, rfOpts{store: st})
			_, err := dc.invoke(e, "rt-old")
			if !IsCode(err, ErrCodeServerError) || !strings.Contains(err.Error(), "session store unavailable") {
				t.Fatalf("err = %v", err)
			}
			if dc.calls(e) != 0 {
				t.Fatal("issuer must not be called")
			}
		})
	}
}

// lockCountStore counts acquires on an otherwise real store.
type lockCountStore struct {
	*MemorySessionStore
	acquires atomic.Int32
}

func (s *lockCountStore) AcquireRefreshLock(ctx context.Context, k string, ttl time.Duration) (bool, func(context.Context) error, error) {
	s.acquires.Add(1)
	return s.MemorySessionStore.AcquireRefreshLock(ctx, k, ttl)
}

// The middleware already holds the lock; the lock is not re-entrant, so its
// handlers must call MFAVerify / RedeemRecoveryCode WITHOUT RefreshToken.
func TestDirectMFA_MiddlewareHandlersTakeTheLockExactlyOnce(t *testing.T) {
	for _, path := range []string{"/mfa/verify", "/mfa/recovery"} {
		path := path
		t.Run(path, func(t *testing.T) {
			st := &lockCountStore{MemorySessionStore: NewMemorySessionStore()}
			e := newRFEnv(t, rfOpts{store: st, opts: MiddlewareOptions{RecoveryPath: "/mfa/recovery"}})
			done := make(chan *httptest.ResponseRecorder, 1)
			go func() { done <- e.post(path, "rt-old", `{"challenge_token":"c","code":"1"}`) }()
			select {
			case w := <-done:
				if w.Code != 200 {
					t.Fatalf("%d %s", w.Code, w.Body.String())
				}
			case <-time.After(2 * time.Second):
				t.Fatal("deadlock: handler re-took its own lock")
			}
			if n := st.acquires.Load(); n != 1 {
				t.Fatalf("acquires = %d, want 1", n)
			}
		})
	}
}
