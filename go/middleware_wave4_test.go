package realmid

// Critic wave 4 (2026-10-01): mutation survivors M13/M23/M30/M32, the lock
// TTL and outcome-store context (SPEC §10.1 step 4a), and the Go-relevant
// LOW findings (L4 customClaims, L5 details.error, L6 GateRequest status).

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---- logout (M13, M30, M32) ----

type recRevocation struct {
	mu  sync.Mutex
	ids map[string]bool
}

func (c *recRevocation) Revoke(_ context.Context, id string, _ time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ids == nil {
		c.ids = map[string]bool{}
	}
	c.ids[id] = true
	return nil
}
func (c *recRevocation) IsRevoked(_ context.Context, id string) (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ids[id], nil
}

// logoutEnv: an issuer whose /auth/logout names the session `S-<refresh>`.
func logoutEnv(t *testing.T, rev RevocationCache) (*Realm, http.Handler, signFn, string) {
	t.Helper()
	sign, key := mintTestKey(t, "k1")
	srv := mwTestServer(t, []jwk{key}, testAud, map[string]http.HandlerFunc{
		"/auth/logout": func(w http.ResponseWriter, r *http.Request) {
			b, _ := io.ReadAll(r.Body)
			var body map[string]any
			_ = json.Unmarshal(b, &body)
			rt, _ := body["refresh_token"].(string)
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "sid": "S-" + rt})
		},
	})
	t.Cleanup(srv.Close)
	r, err := NewRealm(Config{SessionStore: NewMemorySessionStore(), Revocation: rev, RealmID: testRealmID, APIKey: "k", BaseURL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	h := r.Middleware(MiddlewareOptions{})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	return r, h, sign, srv.URL
}

func bearerFor(url string, sign signFn, sid string) string {
	return sign(baseClaims(url, func(c map[string]any) { c["sid"] = sid; c["sub"] = "u" }))
}

func gated(h http.Handler, bearer string) int {
	req := httptest.NewRequest("GET", "/api/x", nil)
	req.Header.Set("Authorization", "Bearer "+bearer)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w.Code
}

func TestSPEC10_1_3_NoCookieBearerOnlyLogoutRevokesTheBearersSession(t *testing.T) {
	_, h, sign, url := logoutEnv(t, nil)
	tok := bearerFor(url, sign, "S1")
	if gated(h, tok) != 200 {
		t.Fatal("precondition: token passes")
	}
	req := httptest.NewRequest("POST", "/logout", nil) // no cookie at all
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("logout: %d", w.Code)
	}
	if got := gated(h, bearerFor(url, sign, "S1")); got != 401 {
		t.Fatalf("a cookie-less logout with a verified bearer must revoke its session, got %d", got)
	}
}

func TestSPEC10_1_3_EveryCookieCandidateIsLoggedOut(t *testing.T) {
	_, h, sign, url := logoutEnv(t, nil)
	req := httptest.NewRequest("POST", "/logout", nil)
	req.AddCookie(&http.Cookie{Name: "realmid_refresh", Value: "rt1"})
	req.AddCookie(&http.Cookie{Name: "realmid_refresh", Value: "rt2"})
	h.ServeHTTP(httptest.NewRecorder(), req)
	for _, sid := range []string{"S-rt1", "S-rt2"} {
		if got := gated(h, bearerFor(url, sign, sid)); got != 401 {
			t.Fatalf("session %s must be revoked (every candidate), got %d", sid, got)
		}
	}
}

func TestSPEC3a2_LogoutPushesTheSessionIntoConfigRevocation(t *testing.T) {
	rev := &recRevocation{}
	r, _, _, _ := logoutEnv(t, rev)
	if err := r.Auth.Logout(context.Background(), &LogoutRequest{RefreshToken: "rt1"}); err != nil {
		t.Fatal(err)
	}
	if ok, _ := rev.IsRevoked(context.Background(), "S-rt1"); !ok {
		t.Fatal("Config.Revocation must receive the logged-out session key")
	}
}

// ---- refresh (M23, M1, L4) ----

func TestSPEC10_1_4a_WinnerReloadWithOtherTenantNeverGetsTheStoredTokens(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	w1 := e.post("/token", "rt-old", `{"tenant_id":"tA"}`)
	if w1.Code != 200 {
		t.Fatalf("tenant A: %d %s", w1.Code, w1.Body.String())
	}
	var a map[string]any
	_ = json.Unmarshal(w1.Body.Bytes(), &a)
	// Sequential, within the 5 s window, SAME cookie, other tenant: the lock
	// is free so this request is a winner that finds A's stored outcome.
	w2 := e.post("/token", "rt-old", `{"tenant_id":"tB"}`)
	if w2.Code != 503 || !strings.Contains(w2.Body.String(), `"retry":true`) {
		t.Fatalf("want 503 retry hand-over, got %d %s", w2.Code, w2.Body.String())
	}
	if strings.Contains(w2.Body.String(), a["access_token"].(string)) {
		t.Fatal("tenant B was handed tenant A's access token")
	}
	if setCookie(w2) != setCookie(w1) || setCookie(w2) == "" {
		t.Fatalf("hand-over must carry the winner's rotated token: %q vs %q", setCookie(w2), setCookie(w1))
	}
	if e.issuerCalls() != 1 {
		t.Fatalf("a winner must not mint while an outcome is stored: %d calls", e.issuerCalls())
	}
}

type recStore struct {
	*MemorySessionStore
	mu       sync.Mutex
	lockTTL  time.Duration
	putCtxOK bool
	puts     int
}

func (s *recStore) AcquireRefreshLock(ctx context.Context, key string, ttl time.Duration) (bool, func(context.Context) error, error) {
	s.mu.Lock()
	s.lockTTL = ttl
	s.mu.Unlock()
	return s.MemorySessionStore.AcquireRefreshLock(ctx, key, ttl)
}

// PutRefreshResult behaves like a ctx-honouring shared store: a dead ctx is
// rejected.
func (s *recStore) PutRefreshResult(ctx context.Context, key string, v []byte, ttl time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	s.puts++
	s.mu.Unlock()
	return s.MemorySessionStore.PutRefreshResult(ctx, key, v, ttl)
}

func TestSPEC10_1_4a_LockTTLExceedsTheMintBound(t *testing.T) {
	st := &recStore{MemorySessionStore: NewMemorySessionStore()}
	e := newRFEnv(t, rfOpts{store: st})
	e.post("/token", "rt-old", `{"tenant_id":"t1"}`)
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.lockTTL < defaultMintTimeout+5*time.Second {
		t.Fatalf("lock TTL %v must be at least the mint bound + 5s", st.lockTTL)
	}
}

func TestSPEC10_1_4a_OutcomeIsStoredEvenWhenTheMintBoundExpired(t *testing.T) {
	st := &recStore{MemorySessionStore: NewMemorySessionStore()}
	e := newRFEnv(t, rfOpts{store: st})
	e.realm.refreshMintTimeout = 100 * time.Millisecond
	e.gate = make(chan struct{}) // issuer hangs until the bound expires
	w := e.post("/token", "rt-old", `{"tenant_id":"t1"}`)
	if w.Code == 200 {
		t.Fatal("hung mint must fail")
	}
	if _, ok, _ := st.GetRefreshResult(context.Background(), refreshOutcomeKey("rt-old")); !ok {
		t.Fatal("the error outcome must be stored under a fresh context, not the expired mint ctx")
	}
}

func TestSPEC10_1_4a_CamelCaseCustomClaimsAreForwarded(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	var got map[string]any
	e.onToken = func(body map[string]any) { got = body }
	e.post("/token", "rt-old", `{"tenant_id":"t1","customClaims":{"k":"v"}}`)
	cc, _ := got["custom_claims"].(map[string]any)
	if cc["k"] != "v" {
		t.Fatalf("customClaims must reach the issuer as custom_claims: %v", got)
	}
}

// ---- LOW: error envelope, GateRequest status ----

func TestRespondAuthFailDetailsCannotClobberTheEnvelope(t *testing.T) {
	r := &Realm{logger: noopLogger()}
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/", nil)
	r.respondAuthFail(w, req, &MiddlewareOptions{}, stageVerify, &RealmError{
		Code: ErrCodeUnauthorized, Message: "m", HTTPStatus: 401, Details: map[string]any{"error": "clobber", "revoked": true},
	})
	var b map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &b)
	env, ok := b["error"].(map[string]any)
	if !ok || env["code"] != "unauthorized" || b["revoked"] != true {
		t.Fatalf("envelope clobbered: %s", w.Body.String())
	}
}

func TestGateRequestErrorCarriesHTTPStatus401(t *testing.T) {
	f := newTokensFixtureForWave4(t)
	err := f.GateRequest(context.Background(), f.revokedToken)
	var re *RealmError
	if !errors.As(err, &re) || re.HTTPStatus != 401 || !errors.Is(err, ErrTokenRevoked) {
		t.Fatalf("want RealmError 401 wrapping ErrTokenRevoked, got %#v", err)
	}
}

type ctxProbeStore struct {
	*MemorySessionStore
	sawKey any
}

type probeKey struct{}

func (s *ctxProbeStore) SessionStates(ctx context.Context, keys []string) ([]SessionState, error) {
	s.sawKey = ctx.Value(probeKey{})
	return s.MemorySessionStore.SessionStates(ctx, keys)
}

func TestGateRequestPassesTheCallersCtxToTheStore(t *testing.T) {
	st := &ctxProbeStore{MemorySessionStore: NewMemorySessionStore()}
	tc := newTokensClient(nil, st, nil, nil)
	sign, _ := mintTestKey(t, "k1")
	tok := sign(baseClaims("http://iss", func(c map[string]any) { c["sid"] = "S1"; c["sub"] = "u" }))
	_ = tc.GateRequest(context.WithValue(context.Background(), probeKey{}, "req"), tok)
	if st.sawKey != "req" {
		t.Fatal("the store must see the caller's ctx, not context.Background()")
	}
}

type wave4Tokens struct {
	*TokensClient
	revokedToken string
}

func newTokensFixtureForWave4(t *testing.T) *wave4Tokens {
	t.Helper()
	sign, _ := mintTestKey(t, "k1")
	tok := sign(baseClaims("http://iss", func(c map[string]any) { c["sid"] = "S1"; c["sub"] = "u" }))
	tc := newTokensClient(nil, NewMemorySessionStore(), nil, nil)
	tc.MarkRevoked(context.Background(), tok)
	return &wave4Tokens{TokensClient: tc, revokedToken: tok}
}

// L2 (final critic): writeRealmError's own "never clobber the envelope" guard
// (the second site; respondAuthFail's twin is covered above).
func TestWriteRealmErrorDetailsCannotClobberTheEnvelope(t *testing.T) {
	w := httptest.NewRecorder()
	writeRealmError(w, &RealmError{
		Code: ErrCodeUnauthorized, Message: "m", HTTPStatus: 401, Details: map[string]any{"error": "clobber", "extra": 1},
	})
	var b map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &b)
	env, ok := b["error"].(map[string]any)
	if !ok || env["code"] != "unauthorized" || b["extra"] != float64(1) {
		t.Fatalf("envelope clobbered: %s", w.Body.String())
	}
}
