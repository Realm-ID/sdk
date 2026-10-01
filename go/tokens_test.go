package realmid

// SPEC §6.7 — session-keyed revocation, refresh not-before marks, the required
// SessionStateStore, and the org-session mode.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func makeJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	hdr := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	body, _ := json.Marshal(claims)
	pl := base64.RawURLEncoding.EncodeToString(body)
	return hdr + "." + pl + ".sig"
}

var t0 = time.Unix(1_700_000_000, 0)

type tokFixture struct {
	tc    *TokensClient
	store *MemorySessionStore
	clock *time.Time
	mode  *string
}

func newTokFixture() *tokFixture {
	clock := t0
	mode := OrgSessionsConcurrent
	store := NewMemorySessionStore()
	store.now = func() time.Time { return clock }
	tc := newTokensClient(func() time.Time { return clock }, store, nil, func(context.Context, string) string { return mode })
	return &tokFixture{tc: tc, store: store, clock: &clock, mode: &mode}
}

func tokOf(t *testing.T, sid, sub string, iat time.Time) string {
	t.Helper()
	c := map[string]any{"iss": "https://x/realm1", "iat": iat.Unix(), "exp": iat.Add(15 * time.Minute).Unix()}
	if sid != "" {
		c["sid"] = sid
	}
	if sub != "" {
		c["sub"] = sub
	}
	return makeJWT(t, c)
}

func TestSPEC6_7_1_SessionKey_SidThenJti(t *testing.T) {
	p, _ := peekSession(makeJWT(t, map[string]any{"sid": "S", "jti": "J"}))
	if p.Key != "S" {
		t.Fatalf("sid must win: %q", p.Key)
	}
	p, _ = peekSession(makeJWT(t, map[string]any{"jti": "J"}))
	if p.Key != "J" {
		t.Fatalf("jti fallback: %q", p.Key)
	}
	p, _ = peekSession(makeJWT(t, map[string]any{"sid": 5, "jti": ""}))
	if p.Key != "" {
		t.Fatalf("non-string sid and empty jti = no key: %q", p.Key)
	}
	cl := &Claims{SessionID: "S", JWTID: "J"}
	if cl.SessionKey() != "S" || (&Claims{JWTID: "J"}).SessionKey() != "J" {
		t.Fatal("Claims.SessionKey")
	}
}

func TestSPEC6_7_2_MarkRevokedRevokesTheSessionNotTheToken(t *testing.T) {
	f := newTokFixture()
	a := tokOf(t, "S1", "u", t0)
	other := tokOf(t, "S1", "u", t0.Add(time.Minute)) // same session, later token
	if f.tc.IsRevoked(a) {
		t.Fatal("fresh store must not flag")
	}
	f.tc.MarkRevoked(a)
	if !f.tc.IsRevoked(a) || !f.tc.IsRevoked(other) {
		t.Fatal("every token of the session must be revoked")
	}
	if f.tc.IsRevoked(tokOf(t, "S2", "u", t0)) {
		t.Fatal("another session must pass")
	}
	// lifetime is now+H, regardless of the token's exp
	*f.clock = t0.Add(23 * time.Hour)
	if !f.tc.IsRevoked(a) {
		t.Fatal("still revoked inside H")
	}
	*f.clock = t0.Add(25 * time.Hour)
	if f.tc.IsRevoked(a) {
		t.Fatal("expired after H")
	}
	if f.store.Len() != 0 {
		t.Fatalf("lazy GC, len=%d", f.store.Len())
	}
}

func TestSPEC6_7_2_NoKeyNoRecord(t *testing.T) {
	f := newTokFixture()
	f.tc.MarkRevoked(makeJWT(t, map[string]any{"exp": t0.Unix() + 60}))
	f.tc.RevokeSession("")
	f.tc.MarkRevoked("not-a-jwt")
	if f.store.Len() != 0 {
		t.Fatal("nothing should be recorded")
	}
	if f.tc.IsRevoked("junk") {
		t.Fatal("malformed must not flag")
	}
}

func TestSPEC6_7_2_RevokeSessionByKey(t *testing.T) {
	f := newTokFixture()
	f.tc.RevokeSession("S9")
	if !f.tc.IsRevoked(tokOf(t, "S9", "u", t0)) {
		t.Fatal("revokeSession(S9)")
	}
}

func TestSPEC6_7_2_RecordRefresh_ConcurrentIsPerMembership(t *testing.T) {
	f := newTokFixture()
	oldGlobex := tokOf(t, "S1", "globex-sub", t0)
	oldAcme := tokOf(t, "S1", "acme-sub", t0)
	f.tc.RecordRefresh(tokOf(t, "S1", "globex-sub", t0.Add(10*time.Second)))
	if !f.tc.IsRevoked(oldGlobex) {
		t.Fatal("older globex token must be refused")
	}
	if f.tc.IsRevoked(oldAcme) {
		t.Fatal("concurrent: acme token must survive")
	}
	if f.tc.IsRevoked(tokOf(t, "S1", "globex-sub", t0.Add(10*time.Second))) {
		t.Fatal("strictly <: same-second token survives")
	}
	err := f.tc.GateRequest(oldGlobex)
	var re *RealmError
	if !errors.Is(err, ErrTokenRevoked) || !errors.As(err, &re) || re.Details["revoked"] != true {
		t.Fatalf("gate error: %v", err)
	}
}

func TestSPEC6_7_3_ExclusiveUsesSessionMark(t *testing.T) {
	f := newTokFixture()
	*f.mode = OrgSessionsExclusive
	f.tc.RecordRefresh(tokOf(t, "S1", "globex-sub", t0.Add(10*time.Second)))
	if !f.tc.IsRevoked(tokOf(t, "S1", "acme-sub", t0)) {
		t.Fatal("exclusive: every org's older token is refused")
	}
}

func TestSPEC6_7_2_MarksNeverLower(t *testing.T) {
	f := newTokFixture()
	f.tc.RecordRefresh(tokOf(t, "S1", "u", t0.Add(30*time.Second)))
	f.tc.RecordRefresh(tokOf(t, "S1", "u", t0.Add(10*time.Second))) // out of order
	if !f.tc.IsRevoked(tokOf(t, "S1", "u", t0.Add(20*time.Second))) {
		t.Fatal("older completion must not lower the mark")
	}
}

func TestSPEC6_7_2_NoIatAgainstLiveMarkIsRefused(t *testing.T) {
	f := newTokFixture()
	f.tc.RecordRefresh(tokOf(t, "S1", "u", t0))
	if !f.tc.IsRevoked(makeJWT(t, map[string]any{"sid": "S1", "sub": "u"})) {
		t.Fatal("no iat against a live mark is refused")
	}
	// recordRefresh no-ops without sub / iat / key
	g := newTokFixture()
	g.tc.RecordRefresh(makeJWT(t, map[string]any{"sid": "S1", "iat": t0.Unix()}))
	g.tc.RecordRefresh(makeJWT(t, map[string]any{"sid": "S1", "sub": "u"}))
	g.tc.RecordRefresh(makeJWT(t, map[string]any{"sub": "u", "iat": t0.Unix()}))
	if g.store.Len() != 0 {
		t.Fatal("must record nothing")
	}
}

func TestSPEC6_7_2_RevokeOnLogout(t *testing.T) {
	f := newTokFixture()
	tok := tokOf(t, "S1", "u", t0)
	boom := errors.New("net down")
	run := f.tc.RevokeOnLogout(func(context.Context, *LogoutRequest) error { return boom })
	if err := run(context.Background(), tok, nil); !errors.Is(err, boom) {
		t.Fatalf("err %v", err)
	}
	if !f.tc.IsRevoked(tok) {
		t.Fatal("marked on failure too")
	}
}

func TestSPEC6_7_2_Evict(t *testing.T) {
	f := newTokFixture()
	f.tc.MarkRevoked(tokOf(t, "S1", "u", t0))
	f.tc.RecordRefresh(tokOf(t, "S1", "u", t0.Add(5*time.Second)))
	f.tc.RevokeSession("S2")
	f.tc.Evict("S1")
	if f.store.Len() != 1 {
		t.Fatalf("only S2 should remain, len=%d", f.store.Len())
	}
	f.tc.Evict("")
	if f.store.Len() != 0 {
		t.Fatal("empty key clears the in-memory store")
	}
}

type failingStore struct{ *MemorySessionStore }

func (failingStore) SessionStates(context.Context, []string) ([]SessionState, error) {
	return nil, errors.New("redis down")
}

func TestSPEC6_7_2_StoreReadErrorFailsOpen(t *testing.T) {
	tc := newTokensClient(nil, failingStore{NewMemorySessionStore()}, nil, nil)
	if tc.IsRevoked(tokOf(t, "S1", "u", t0)) {
		t.Fatal("read error must fail open")
	}
}

func TestSPEC6_7_5_StoreIsRequired(t *testing.T) {
	r, err := NewRealm(Config{RealmID: "r", APIKey: "k"})
	if r != nil || !errors.Is(err, ErrSessionStoreRequired) {
		t.Fatalf("got %v %v", r, err)
	}
	if !strings.Contains(err.Error(), "NewMemorySessionStore()") {
		t.Fatalf("message: %v", err)
	}
}

func TestSPEC6_7_5_KeysAreNamespacedAndEscaped(t *testing.T) {
	if k := membershipMarkKey("a|b", "c%d"); k != "realmid:v1:nb|a%7Cb|c%25d" {
		t.Fatal(k)
	}
	if k := revokedKey("S"); k != "realmid:v1:rev|S" {
		t.Fatal(k)
	}
	if strings.Contains(refreshLockKey("secret-refresh-token"), "secret") {
		t.Fatal("raw refresh token must never appear in a key")
	}
}

func TestSPEC6_7_5_MemoryStoreSemantics(t *testing.T) {
	s := NewMemorySessionStore()
	now := t0
	s.now = func() time.Time { return now }
	ctx := context.Background()
	_ = s.RevokeSession(ctx, "k", now.Add(time.Hour))
	_ = s.RevokeSession(ctx, "k", now.Add(time.Minute)) // never shortens
	now = now.Add(30 * time.Minute)
	if st, _ := s.SessionStates(ctx, []string{"k", "absent"}); !st[0].Revoked || st[1].Revoked {
		t.Fatalf("states %+v", st)
	}
	_ = s.RaiseNotBefore(ctx, "nb", t0.Add(10*time.Second), now.Add(time.Hour))
	_ = s.RaiseNotBefore(ctx, "nb", t0.Add(5*time.Second), now.Add(2*time.Hour))
	if st, _ := s.SessionStates(ctx, []string{"nb"}); !st[0].NotBefore.Equal(t0.Add(10 * time.Second)) {
		t.Fatalf("nb lowered: %+v", st)
	}
	// lock: set-if-absent, fenced release
	ok, rel, _ := s.AcquireRefreshLock(ctx, "l", 10*time.Second)
	ok2, _, _ := s.AcquireRefreshLock(ctx, "l", 10*time.Second)
	if !ok || ok2 {
		t.Fatalf("lock %v %v", ok, ok2)
	}
	now = now.Add(11 * time.Second) // lock expired; a new holder takes it
	ok3, rel3, _ := s.AcquireRefreshLock(ctx, "l", 10*time.Second)
	rel() // stale holder: must NOT free the new holder's lock
	ok4, _, _ := s.AcquireRefreshLock(ctx, "l", 10*time.Second)
	if !ok3 || ok4 {
		t.Fatalf("fenced release broken %v %v", ok3, ok4)
	}
	rel3()
	// outcome: exact ttl
	_ = s.PutRefreshResult(ctx, "o", []byte("x"), 5*time.Second)
	if v, ok, _ := s.GetRefreshResult(ctx, "o"); !ok || string(v) != "x" {
		t.Fatal("result")
	}
	now = now.Add(6 * time.Second)
	if _, ok, _ := s.GetRefreshResult(ctx, "o"); ok {
		t.Fatal("result must expire at ttl")
	}
}

// --- org-session mode from discovery ---

func modeServer(t *testing.T, body string, status int, hits *atomic.Int32) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/.well-known/openid-configuration") {
			hits.Add(1)
			w.WriteHeader(status)
			_, _ = w.Write([]byte(body))
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestSPEC6_7_3_ModeFromDiscovery(t *testing.T) {
	cases := map[string]struct {
		body   string
		status int
		want   string
	}{
		"exclusive":  {`{"realmid_org_sessions":"exclusive"}`, 200, OrgSessionsExclusive},
		"concurrent": {`{"realmid_org_sessions":"concurrent"}`, 200, OrgSessionsConcurrent},
		"absent":     {`{}`, 200, OrgSessionsConcurrent},
		"empty":      {`{"realmid_org_sessions":""}`, 200, OrgSessionsConcurrent},
		"unknown":    {`{"realmid_org_sessions":"weird"}`, 200, OrgSessionsConcurrent},
		"fetch 500":  {`boom`, 500, OrgSessionsConcurrent},
	}
	for name, c := range cases {
		hits := &atomic.Int32{}
		srv := modeServer(t, c.body, c.status, hits)
		r, err := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: "realm1", APIKey: "k", BaseURL: srv.URL})
		if err != nil {
			t.Fatal(err)
		}
		iss := srv.URL + "/realm1"
		if got := r.modes.mode(context.Background(), iss); got != c.want {
			t.Fatalf("%s: got %q want %q", name, got, c.want)
		}
		r.modes.mode(context.Background(), iss)
		if hits.Load() != 1 {
			t.Fatalf("%s: cached for 10 min, hits=%d", name, hits.Load())
		}
	}
}

func TestSPEC6_7_3_ModeNotFetchedWithoutALiveMark(t *testing.T) {
	hits := &atomic.Int32{}
	srv := modeServer(t, `{"realmid_org_sessions":"exclusive"}`, 200, hits)
	r, _ := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: "realm1", APIKey: "k", BaseURL: srv.URL})
	tok := makeJWT(t, map[string]any{"iss": srv.URL + "/realm1", "sid": "S", "sub": "u", "iat": time.Now().Unix()})
	if r.Tokens.IsRevoked(tok) || hits.Load() != 0 {
		t.Fatalf("no mark: no fetch; hits=%d", hits.Load())
	}
	r.Tokens.RecordRefresh(makeJWT(t, map[string]any{"iss": srv.URL + "/realm1", "sid": "S", "sub": "u", "iat": time.Now().Unix() + 100}))
	r.Tokens.IsRevoked(tok)
	if hits.Load() != 1 {
		t.Fatalf("live mark: one fetch; hits=%d", hits.Load())
	}
}

// SPEC6_7_6 R3/R2 — Config.Revocation is keyed on the session key.
func TestSPEC6_7_6_RevocationCacheKeyedOnSession(t *testing.T) {
	rev := NewMemRevocationCache(nil)
	e := newV063Env(t, func(c *Config) { c.Revocation = rev })
	// sid present, jti unique per token (Issuer B): denying the sid denies every token
	_ = rev.Revoke(context.Background(), "S1", time.Now().Add(time.Hour))
	_, err := e.realm.Verify(context.Background(), e.tok(nil, func(c map[string]any) { c["sid"] = "S1"; c["jti"] = "unique-1" }), nil)
	var re *RealmError
	if !errors.As(err, &re) || re.Code != ErrCodeUnauthorized {
		t.Fatalf("sid-keyed denial: %v", err)
	}
	// jti fallback when there is no sid (v0.126.0)
	_ = rev.Revoke(context.Background(), "J9", time.Now().Add(time.Hour))
	if _, err := e.realm.Verify(context.Background(), e.tok(nil, func(c map[string]any) { c["jti"] = "J9" }), nil); err == nil {
		t.Fatal("jti fallback must deny")
	}
	// a jti that merely equals nothing revoked verifies when a sid names a live session
	if _, err := e.realm.Verify(context.Background(), e.tok(nil, func(c map[string]any) { c["sid"] = "S2"; c["jti"] = "J9" }), nil); err != nil {
		t.Fatalf("sid present: jti is ignored for keying: %v", err)
	}
}
