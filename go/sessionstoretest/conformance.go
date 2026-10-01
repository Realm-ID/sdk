// Package sessionstoretest is the conformance suite for realmid.SessionStateStore
// (SPEC §6.7.5). A partner backing the store with Redis or a database runs it
// from their own test:
//
//	func TestMyStore(t *testing.T) {
//		sessionstoretest.Run(t, func() realmid.SessionStateStore { return newMyStore(t) })
//	}
//
// It uses short REAL TTLs (tens of milliseconds), so it needs no clock hook and
// works against any backend. Each subtest gets a fresh store from the factory.
package sessionstoretest

import (
	ctxpkg "context"
	"testing"
	"time"

	realmid "github.com/Realm-ID/sdk/go"
)

const tick = 120 * time.Millisecond

// Run executes every conformance case against stores built by newStore.
func Run(t *testing.T, newStore func() realmid.SessionStateStore) {
	t.Helper()
	cases := []struct {
		name string
		fn   func(t *testing.T, s realmid.SessionStateStore)
	}{
		{"absent keys read as the zero state, in order", absentKeys},
		{"RevokeSession never shortens", revokeNeverShortens},
		{"RaiseNotBefore never lowers and never shortens", raiseNeverLowers},
		{"an expired entry reads as absent", expiredIsAbsent},
		{"Evict drops the key and its prefix+| children, nothing else", evictPrefix},
		{"AcquireRefreshLock is set-if-absent with a TTL", lockSetIfAbsent},
		{"lock release is fenced to its holder", lockReleaseFenced},
		{"refresh result lives for exactly its TTL", resultExactTTL},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) { c.fn(t, newStore()) })
	}
}

var bg = ctxpkg.Background()

func states(t *testing.T, s realmid.SessionStateStore, keys ...string) []realmid.SessionState {
	t.Helper()
	out, err := s.SessionStates(bg, keys)
	if err != nil {
		t.Fatalf("SessionStates: %v", err)
	}
	if len(out) != len(keys) {
		t.Fatalf("SessionStates returned %d states for %d keys", len(out), len(keys))
	}
	return out
}

func absentKeys(t *testing.T, s realmid.SessionStateStore) {
	for i, st := range states(t, s, "a", "b", "c") {
		if st.Revoked || !st.NotBefore.IsZero() {
			t.Fatalf("key %d not zero: %+v", i, st)
		}
	}
	if err := s.RevokeSession(bg, "", time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("empty key must be a no-op, got %v", err)
	}
	st := states(t, s, "x", "rev", "y")
	_ = s.RevokeSession(bg, "rev", time.Now().Add(time.Hour))
	st = states(t, s, "x", "rev", "y")
	if st[0].Revoked || !st[1].Revoked || st[2].Revoked {
		t.Fatalf("order not preserved: %+v", st)
	}
}

func revokeNeverShortens(t *testing.T, s realmid.SessionStateStore) {
	_ = s.RevokeSession(bg, "k", time.Now().Add(3*tick))
	_ = s.RevokeSession(bg, "k", time.Now().Add(tick/4)) // an EARLIER until must not win
	time.Sleep(tick)
	if !states(t, s, "k")[0].Revoked {
		t.Fatal("a later write shortened the revocation")
	}
}

func raiseNeverLowers(t *testing.T, s realmid.SessionStateStore) {
	hi := time.Unix(2_000_000_100, 0)
	lo := time.Unix(2_000_000_000, 0)
	_ = s.RaiseNotBefore(bg, "nb", hi, time.Now().Add(3*tick))
	_ = s.RaiseNotBefore(bg, "nb", lo, time.Now().Add(tick/4)) // lower nb AND shorter until
	time.Sleep(tick)
	got := states(t, s, "nb")[0].NotBefore
	if !got.Equal(hi) {
		t.Fatalf("not-before = %v, want %v (never lowered, never shortened)", got, hi)
	}
}

func expiredIsAbsent(t *testing.T, s realmid.SessionStateStore) {
	_ = s.RevokeSession(bg, "k", time.Now().Add(tick/2))
	_ = s.RaiseNotBefore(bg, "nb", time.Unix(2_000_000_000, 0), time.Now().Add(tick/2))
	time.Sleep(tick)
	for _, st := range states(t, s, "k", "nb") {
		if st.Revoked || !st.NotBefore.IsZero() {
			t.Fatalf("expired entry still visible: %+v", st)
		}
	}
}

func evictPrefix(t *testing.T, s realmid.SessionStateStore) {
	until := time.Now().Add(time.Hour)
	for _, k := range []string{"nb|S1", "nb|S1|sub", "nb|S10", "nb|S2"} {
		_ = s.RevokeSession(bg, k, until)
	}
	if err := s.Evict(bg, "nb|S1"); err != nil {
		t.Fatal(err)
	}
	st := states(t, s, "nb|S1", "nb|S1|sub", "nb|S10", "nb|S2")
	if st[0].Revoked || st[1].Revoked {
		t.Fatalf("Evict must drop the key and its children: %+v", st)
	}
	if !st[2].Revoked || !st[3].Revoked {
		t.Fatalf("Evict(nb|S1) must NOT touch nb|S10 or nb|S2: %+v", st)
	}
}

func lockSetIfAbsent(t *testing.T, s realmid.SessionStateStore) {
	ok, rel, err := s.AcquireRefreshLock(bg, "l", 2*tick)
	if err != nil || !ok {
		t.Fatalf("first acquire: %v %v", ok, err)
	}
	if ok2, _, _ := s.AcquireRefreshLock(bg, "l", 2*tick); ok2 {
		t.Fatal("second acquire must lose while the lock is held")
	}
	rel()
	if ok3, rel3, _ := s.AcquireRefreshLock(bg, "l", tick/2); !ok3 {
		t.Fatal("acquire after release must win")
	} else {
		time.Sleep(tick)
		_ = rel3
	}
	if ok4, rel4, _ := s.AcquireRefreshLock(bg, "l", tick); !ok4 {
		t.Fatal("an expired lock must be acquirable")
	} else {
		rel4()
	}
}

func lockReleaseFenced(t *testing.T, s realmid.SessionStateStore) {
	_, staleRelease, _ := s.AcquireRefreshLock(bg, "l", tick/2)
	time.Sleep(tick) // the first holder's lock expires
	ok, rel, _ := s.AcquireRefreshLock(bg, "l", 5*tick)
	if !ok {
		t.Fatal("second holder must acquire the expired lock")
	}
	defer rel()
	staleRelease() // must NOT free the new holder's lock
	if ok3, _, _ := s.AcquireRefreshLock(bg, "l", tick); ok3 {
		t.Fatal("a stale holder's release freed the new holder's lock")
	}
}

func resultExactTTL(t *testing.T, s realmid.SessionStateStore) {
	if _, ok, err := s.GetRefreshResult(bg, "o"); ok || err != nil {
		t.Fatalf("absent result: %v %v", ok, err)
	}
	if err := s.PutRefreshResult(bg, "o", []byte("secret"), 2*tick); err != nil {
		t.Fatal(err)
	}
	if v, ok, _ := s.GetRefreshResult(bg, "o"); !ok || string(v) != "secret" {
		t.Fatalf("result not readable inside its TTL: %q %v", v, ok)
	}
	time.Sleep(3 * tick)
	if _, ok, _ := s.GetRefreshResult(bg, "o"); ok {
		t.Fatal("result outlived its TTL")
	}
}
