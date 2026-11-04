package realmid

// Round-3 pins: the sweep spares live revocations; only refresh-token-level
// error outcomes are shared across request shapes; the TokenManager persists a
// token adopted from a superseded give-up.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
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

// ---- SPEC §4.2 "An error after a hand-over carries the newest token" ----

// failLockKeyStore fails AcquireRefreshLock for one lock key only, so hop 0
// (on the presented token) succeeds and hop 1 (on the handed-over token) hits a
// session-store failure.
type failLockKeyStore struct {
	*MemorySessionStore
	failKey string
}

func (s *failLockKeyStore) AcquireRefreshLock(ctx context.Context, k string, ttl time.Duration) (bool, func(context.Context) error, error) {
	if k == s.failKey {
		return false, nil, errors.New("redis down")
	}
	return s.MemorySessionStore.AcquireRefreshLock(ctx, k, ttl)
}

// handOverRT1 seeds ONE hand-over: "rt-old" was spent by someone else's
// differently-shaped request and rotated to "rt-1".
func handOverRT1(t *testing.T, st *MemorySessionStore) {
	t.Helper()
	seedSuperseded(t, st, "rt-old", "rt-1")
}

func handedOver(t *testing.T, err error) *RefreshHandedOverError {
	t.Helper()
	var ho *RefreshHandedOverError
	if !errors.As(err, &ho) {
		t.Fatalf("err = %T %v, want *RefreshHandedOverError", err, err)
	}
	return ho
}

func TestSPEC4_2_handover_LockStoreFailureCarriesHop1Token(t *testing.T) {
	st := &failLockKeyStore{MemorySessionStore: NewMemorySessionStore(), failKey: refreshLockKey("rt-1")}
	handOverRT1(t, st.MemorySessionStore)
	e := newRFEnv(t, rfOpts{store: st})
	_, err := e.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: "rt-old", TenantID: "t1"})
	if ho := handedOver(t, err); ho.RefreshToken() != "rt-1" {
		t.Fatalf("carried %q, want rt-1", ho.RefreshToken())
	}
	if !IsCode(err, ErrCodeServerError) || !strings.Contains(err.Error(), "session store unavailable") {
		t.Fatalf("original lost: %v", err)
	}
}

func TestSPEC4_2_handover_ShapeSpecific403CarriesHop1Token(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	handOverRT1(t, e.store)
	raw, _ := json.Marshal(refreshOutcome{Fingerprint: tokenFingerprint(TokenRequest{TenantID: "t1"}), Err: &storedErr{Code: string(ErrCodeForbidden), Message: "empty intersection", Status: 403}})
	if err := e.store.PutRefreshResult(context.Background(), refreshOutcomeKey("rt-1"), raw, time.Minute); err != nil {
		t.Fatal(err)
	}
	_, err := e.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: "rt-old", TenantID: "t1"})
	if ho := handedOver(t, err); ho.RefreshToken() != "rt-1" {
		t.Fatalf("carried %q, want rt-1", ho.RefreshToken())
	}
	var re *RealmError
	if !errors.As(err, &re) || re.HTTPStatus != 403 || re.Code != ErrCodeForbidden || !IsCode(err, ErrCodeForbidden) {
		t.Fatalf("original lost through Unwrap: %v", err)
	}
}

func TestSPEC4_2_handover_CancelledContextCarriesHop1Token(t *testing.T) {
	st := &ctxStore{MemorySessionStore: NewMemorySessionStore()}
	handOverRT1(t, st.MemorySessionStore)
	e := newRFEnv(t, rfOpts{store: st})
	ctx, cancel := context.WithCancel(context.Background())
	st.cancel = cancel // fires when hop 0 takes its lock; hop 1 then sees the done ctx
	_, err := e.realm.Auth.Token(ctx, TokenRequest{RefreshToken: "rt-old", TenantID: "t1"})
	if ho := handedOver(t, err); ho.RefreshToken() != "rt-1" {
		t.Fatalf("carried %q, want rt-1", ho.RefreshToken())
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("errors.Is(Canceled) lost through Unwrap: %v", err)
	}
}

func TestSPEC4_2_handover_TokenLevelErrorCarriesNothing(t *testing.T) {
	for _, se := range []*storedErr{
		{Code: string(ErrCodeRefreshInvalid), Message: "dead", Status: 401},
		{Code: string(ErrCodeUnauthorized), Message: "reuse", Status: 401},
	} {
		e := newRFEnv(t, rfOpts{})
		handOverRT1(t, e.store)
		seedErrOutcome(t, e.store, "rt-1", se)
		_, err := e.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: "rt-old", TenantID: "t1"})
		var ho *RefreshHandedOverError
		var ss *RefreshSupersededError
		if err == nil || errors.As(err, &ho) || errors.As(err, &ss) || !IsCode(err, ErrorCode(se.Code)) {
			t.Fatalf("%s: err = %T %v, want the bare token-level error", se.Code, err, err)
		}
	}
}

func TestSPEC4_2_handover_TokenIsRedactedEverywhere(t *testing.T) {
	st := &failLockKeyStore{MemorySessionStore: NewMemorySessionStore(), failKey: refreshLockKey("rt-SECRET")}
	seedSuperseded(t, st.MemorySessionStore, "rt-old", "rt-SECRET")
	e := newRFEnv(t, rfOpts{store: st})
	_, err := e.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: "rt-old", TenantID: "t1"})
	ho := handedOver(t, err)
	if ho.RefreshToken() != "rt-SECRET" {
		t.Fatalf("carried %q", ho.RefreshToken())
	}
	b, merr := json.Marshal(ho)
	if merr != nil || !strings.Contains(string(b), `"code":"server_error"`) || !strings.Contains(string(b), `"status":503`) {
		t.Fatalf("json = %s (%v)", b, merr)
	}
	for _, s := range []string{err.Error(), fmt.Sprintf("%v", err), fmt.Sprintf("%+v", err), fmt.Sprintf("%#v", err), fmt.Sprintf("%v", ho), fmt.Sprintf("%+v", ho), fmt.Sprintf("%#v", ho), string(b)} {
		if strings.Contains(s, "rt-SECRET") {
			t.Fatalf("live refresh token leaked: %q", s)
		}
	}
}

func TestSPEC4_2_handover_Hop0ErrorIsUnchanged(t *testing.T) {
	st := &failLockKeyStore{MemorySessionStore: NewMemorySessionStore(), failKey: refreshLockKey("rt-old")}
	e := newRFEnv(t, rfOpts{store: st})
	_, err := e.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: "rt-old", TenantID: "t1"})
	var ho *RefreshHandedOverError
	var re *RealmError
	if err == nil || errors.As(err, &ho) || !errors.As(err, &re) || err != error(re) {
		t.Fatalf("hop-0 err = %T %v, want the bare *RealmError", err, err)
	}
}

func TestSPEC4_2_1_adopt_ManagerAdoptsAndPersistsHandedOverToken(t *testing.T) {
	st := &failLockKeyStore{MemorySessionStore: NewMemorySessionStore(), failKey: refreshLockKey("rt-1")}
	handOverRT1(t, st.MemorySessionStore)
	e := newRFEnv(t, rfOpts{store: st})
	var mu sync.Mutex
	var persisted []string
	m := e.realm.Auth.NewTokenManager("rt-old", WithRefreshSink(func(_ context.Context, tok string) error {
		mu.Lock()
		defer mu.Unlock()
		persisted = append(persisted, tok)
		return nil
	}))
	tok, err := m.AccessToken(context.Background())
	if err == nil || tok != "" {
		t.Fatalf("the acquisition must still fail: tok=%q err=%v", tok, err)
	}
	if got := m.RefreshToken(); got != "rt-1" {
		t.Fatalf("manager holds %q, want rt-1", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(persisted) != 1 || persisted[0] != "rt-1" {
		t.Fatalf("sink saw %v, want [rt-1]", persisted)
	}
}
