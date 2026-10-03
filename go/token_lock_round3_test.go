package realmid

// Round-3 pins: the sweep spares live revocations; only refresh-token-level
// error outcomes are shared across request shapes; the TokenManager persists a
// token adopted from a superseded give-up.

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"
)

func TestMemorySessionStore_SweepSparesLiveRevocations(t *testing.T) {
	st := NewMemorySessionStore()
	clock := time.Now()
	st.now = func() time.Time { return clock }
	ctx := context.Background()
	_ = st.PutRefreshResult(ctx, "first", []byte("x"), time.Second) // arms nextSweep
	if err := st.RevokeSession(ctx, "sid-live", clock.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(2 * time.Minute) // past the 30 s sweep interval; the revocation has ~58 min left
	_ = st.PutRefreshResult(ctx, "trigger", []byte("x"), time.Second)
	got, _ := st.SessionStates(ctx, []string{"sid-live"})
	if len(got) != 1 || !got[0].Revoked {
		t.Fatalf("a live revocation was swept: %+v", got)
	}
}

func seedErrOutcome(t *testing.T, st *MemorySessionStore, key string, se *storedErr) {
	t.Helper()
	raw, _ := json.Marshal(refreshOutcome{Fingerprint: "someone-else", Err: se})
	if err := st.PutRefreshResult(context.Background(), refreshOutcomeKey(key), raw, time.Minute); err != nil {
		t.Fatal(err)
	}
}

// A stored error that is about the refresh token itself is the same for every
// request shape and is shared; a shape-specific one (here a 403 for another
// tenant's narrowing) is not, and this request mints for itself.
func TestToken_OnlyTokenLevelErrorOutcomesAreSharedAcrossShapes(t *testing.T) {
	t.Run("refresh_invalid is shared", func(t *testing.T) {
		e := newRFEnv(t, rfOpts{})
		seedErrOutcome(t, e.store, "rt-old", &storedErr{Code: string(ErrCodeRefreshInvalid), Message: "dead", Status: 401})
		_, err := e.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: "rt-old", TenantID: "t1"})
		if !IsCode(err, ErrCodeRefreshInvalid) || e.issuerCalls() != 0 {
			t.Fatalf("err=%v issuer=%v", err, e.seenTokens())
		}
	})
	t.Run("a spent-token 401 is shared", func(t *testing.T) {
		e := newRFEnv(t, rfOpts{})
		seedErrOutcome(t, e.store, "rt-old", &storedErr{Code: string(ErrCodeUnauthorized), Message: "reuse", Status: 401})
		_, err := e.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: "rt-old", TenantID: "t1"})
		if !IsCode(err, ErrCodeUnauthorized) || e.issuerCalls() != 0 {
			t.Fatalf("err=%v issuer=%v", err, e.seenTokens())
		}
	})
	t.Run("a shape-specific 403 is not shared", func(t *testing.T) {
		e := newRFEnv(t, rfOpts{})
		seedErrOutcome(t, e.store, "rt-old", &storedErr{Code: string(ErrCodeForbidden), Message: "empty intersection for org X", Status: 403})
		mr, err := e.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: "rt-old", TenantID: "t1"})
		if err != nil || mr == nil || e.issuerCalls() != 1 {
			t.Fatalf("mr=%+v err=%v issuer=%v", mr, err, e.seenTokens())
		}
	})
}

func TestTokenManager_PersistsTheTokenAdoptedFromASupersededGiveUp(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	seedSuperseded(t, e.store, "rt-old", "rt-1", "rt-2", "rt-3")
	var mu sync.Mutex
	var persisted []string
	m := e.realm.Auth.NewTokenManager("rt-old", WithRefreshSink(func(_ context.Context, tok string) error {
		mu.Lock()
		defer mu.Unlock()
		persisted = append(persisted, tok)
		return nil
	}))
	if _, err := m.AccessToken(context.Background()); err == nil {
		t.Fatal("want the superseded give-up error")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(persisted) != 1 || persisted[0] != "rt-3" {
		t.Fatalf("sink saw %v; a restart would present the spent token", persisted)
	}
}
