package realmid

import (
	"context"
	"encoding/json"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// authority_test.go — ADR-107: logout, demotion and promotion propagate inside
// the SDK.
//
// The jti-keyed RevocationCache can only express "this TOKEN is dead", which is
// why it serves logout and nothing else: the user presents their own token, so
// the SDK holds the jti at the moment it needs it. An admin demoting a
// colleague holds neither that colleague's token nor its jti (ADR-107 C2), so
// the subject-keyed AuthorityCache exists beside it — NOT instead of it (D1).
//
// The hazard these tests are mostly about is NOT the demotion window. It is the
// refresh LOOP in C5: stamp `notBefore` from the partner's clock, compare it to
// an `iat` stamped by the issuer's, and two seconds of forward skew turns every
// freshly-minted token into a stale one — refresh, fail, refresh, from every
// replica, aimed at the mint endpoint. D8 (stamp early) and D13 (honour a
// forced refresh at most once per token) are the two guards, and both are
// tested here.

// ---- The cache itself (D3, D6) ---------------------------------------------

func TestMemAuthorityCache_StoresATimestampNotAFlag(t *testing.T) {
	now := time.Now()
	c := NewMemAuthorityCache(func() time.Time { return now })
	ctx := context.Background()

	if _, found, err := c.StaleSince(ctx, "sub-1"); err != nil || found {
		t.Fatalf("unmarked subject: found=%v err=%v, want false/nil", found, err)
	}

	nb := now.Add(-30 * time.Second)
	if err := c.MarkStale(ctx, "sub-1", nb, now.Add(15*time.Minute)); err != nil {
		t.Fatalf("MarkStale: %v", err)
	}
	got, found, err := c.StaleSince(ctx, "sub-1")
	if err != nil || !found {
		t.Fatalf("StaleSince: found=%v err=%v", found, err)
	}
	// D3: the stored value is the marker itself. A boolean could not self-heal
	// — it would reject the REFRESHED token too, turning a demotion into an
	// outage for the whole TTL.
	if !got.Equal(nb) {
		t.Errorf("notBefore = %v, want %v", got, nb)
	}
}

func TestMemAuthorityCache_EvictsOnReadAfterTTL(t *testing.T) {
	now := time.Now()
	clock := now
	c := NewMemAuthorityCache(func() time.Time { return clock })
	ctx := context.Background()

	// D6: TTL is the maximum access-token lifetime plus leeway. After that no
	// token minted before the change can still verify, so the entry is dead
	// weight and memory is bounded by (subjects changed) × (one TTL).
	_ = c.MarkStale(ctx, "sub-1", now, now.Add(15*time.Minute))
	clock = now.Add(16 * time.Minute)
	if _, found, _ := c.StaleSince(ctx, "sub-1"); found {
		t.Error("entry survived its TTL — the cache grows without bound")
	}
	if n := c.Len(); n != 0 {
		t.Errorf("Len after eviction = %d, want 0", n)
	}
}

// D4: the key is `sub`, verbatim — the PER-MEMBERSHIP users-row id, not a
// person. Demoting someone in org A must leave their org B token untouched.
// That blast radius is the whole reason `sub` was chosen over an identity id.
func TestMemAuthorityCache_KeyIsPerMembership(t *testing.T) {
	now := time.Now()
	c := NewMemAuthorityCache(func() time.Time { return now })
	ctx := context.Background()
	_ = c.MarkStale(ctx, "sub-org-a", now, now.Add(time.Minute))
	if _, found, _ := c.StaleSince(ctx, "sub-org-b"); found {
		t.Error("marking one membership stale marked another — D4's blast radius is broken")
	}
}

// ---- The notify method (D7, D11, D15) --------------------------------------

func TestNotifyAuthorityChanged_MarksTheSubjectStale(t *testing.T) {
	srv := mwTestServer(t, nil, testAud, nil)
	defer srv.Close()
	now := time.Now()
	cache := NewMemAuthorityCache(func() time.Time { return now })
	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
		Authority: cache,
		Clock:     func() time.Time { return now },
	})

	if err := r.NotifyAuthorityChanged(context.Background(), AuthorityChange{
		Subject: "sub-1", Intent: AuthorityIntentDemoted,
	}); err != nil {
		t.Fatalf("NotifyAuthorityChanged: %v", err)
	}
	nb, found, _ := cache.StaleSince(context.Background(), "sub-1")
	if !found {
		t.Fatal("subject was not marked stale")
	}
	// D8: stamped as localNow − skewAllowance, NEVER bare localNow. Erring
	// early over-rejects a handful of very recently minted tokens — one extra,
	// harmless refresh each — and can never place the marker in the ISSUER's
	// future, which is the only way the C5 loop starts.
	if !nb.Before(now) {
		t.Errorf("notBefore = %v, is not before local now %v — D8's skew allowance is missing "+
			"and a forward-skewed partner clock will loop the mint endpoint", nb, now)
	}
	if d := now.Sub(nb); d < 20*time.Second {
		t.Errorf("skew allowance = %v, want at least ~30s of margin", d)
	}
}

// D11: demotion does NOT evict the session, so the method cannot be allowed to
// GUESS what the partner meant. A method that inferred intent would eventually
// infer "log them out" on a routine role edit.
func TestNotifyAuthorityChanged_IntentIsRequired(t *testing.T) {
	srv := mwTestServer(t, nil, testAud, nil)
	defer srv.Close()
	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
		Authority: NewMemAuthorityCache(nil),
	})
	cases := []struct {
		name string
		ch   AuthorityChange
	}{
		{"no intent", AuthorityChange{Subject: "sub-1"}},
		{"unknown intent", AuthorityChange{Subject: "sub-1", Intent: AuthorityChangeIntent("logged_out")}},
		{"no subject", AuthorityChange{Intent: AuthorityIntentPromoted}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if err := r.NotifyAuthorityChanged(context.Background(), c.ch); err == nil {
				t.Fatal("want an error, got nil")
			}
		})
	}
}

// D15: calling notify with no AuthorityCache configured is an ERROR, not a
// no-op. Silence here means a partner believes demotion is propagating while
// nothing is stored — the "cache that reports nothing" failure this workspace
// has recorded three times.
func TestNotifyAuthorityChanged_NoCacheIsAnError(t *testing.T) {
	srv := mwTestServer(t, nil, testAud, nil)
	defer srv.Close()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})

	err := r.NotifyAuthorityChanged(context.Background(), AuthorityChange{
		Subject: "sub-1", Intent: AuthorityIntentDemoted,
	})
	if err == nil {
		t.Fatal("notify with no cache configured returned nil — a partner would believe " +
			"demotion is propagating while nothing is stored")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "authority") {
		t.Errorf("error does not name the missing cache: %v", err)
	}
}

// D1/D2: two caches, not one widened interface. A partner's existing
// RevocationCache implementation must keep working untouched — in Go a widened
// interface breaks the build, and in ts/Java it breaks SILENTLY at runtime.
func TestAuthorityAndRevocationAreSeparateFields(t *testing.T) {
	srv := mwTestServer(t, nil, testAud, nil)
	defer srv.Close()
	rev := NewMemRevocationCache(nil)
	auth := NewMemAuthorityCache(nil)
	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
		Revocation: rev, Authority: auth,
	})
	if r.Revocation() != RevocationCache(rev) {
		t.Error("Revocation() no longer returns the configured jti denylist")
	}
	if r.Authority() != AuthorityCache(auth) {
		t.Error("Authority() does not return the configured subject cache")
	}
}

// ---- The verifier check (D3, D8, D9, D10) ----------------------------------

func staleVerifierRealm(t *testing.T, cache AuthorityCache, now time.Time) (*Realm, signFn, func()) {
	t.Helper()
	sign, pub := mintKey(t, "kid-1")
	srv := fakeServer(t, map[string][]jwk{testRealmID: {pub}}, testAud)
	r, err := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk_live_test", BaseURL: srv.URL,
		Authority: cache,
		Clock:     func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewRealm: %v", err)
	}
	return r, sign, srv.Close
}

func TestVerify_TokenMintedBeforeTheChangeIsStale(t *testing.T) {
	now := time.Now()
	cache := NewMemAuthorityCache(func() time.Time { return now })
	r, sign, closeSrv := staleVerifierRealm(t, cache, now)
	defer closeSrv()

	// The demoted admin's token, minted ten minutes ago.
	tok := sign(map[string]any{
		"iss": r.BaseURL() + "/" + testRealmID, "sub": "01HUSER", "aud": testAud,
		"iat": now.Add(-10 * time.Minute).Unix(), "exp": now.Add(5 * time.Minute).Unix(),
	})
	if _, err := r.Verify(context.Background(), tok, nil); err != nil {
		t.Fatalf("pre-condition: token should verify before the change: %v", err)
	}

	_ = cache.MarkStale(context.Background(), "01HUSER", now.Add(-time.Minute), now.Add(15*time.Minute))

	_, err := r.Verify(context.Background(), tok, nil)
	if err == nil {
		t.Fatal("a token minted before the authority change still verified — the demoted " +
			"admin keeps their old claims for up to access_ttl_seconds")
	}
	// D10: a NEW code, distinct from `unauthorized` and `refresh_invalid`.
	// Without it a client that treats every 401 as "sign the user out" signs
	// people out on PROMOTION.
	if !IsCode(err, ErrCodeTokenStale) {
		t.Fatalf("code = %v, want token_stale", err)
	}
	if !IsTokenStale(err) {
		t.Error("IsTokenStale did not recognise its own error")
	}
	if got := HTTPStatus(err); got != http.StatusUnauthorized {
		t.Errorf("HTTPStatus = %d, want 401 (D10)", got)
	}
}

// D3's self-heal, and the single most important assertion in this file: the
// REFRESHED token must pass. A flag-valued cache would reject this one too and
// lock the user out for the whole TTL.
func TestVerify_RefreshedTokenPassesTheSameMarker(t *testing.T) {
	now := time.Now()
	cache := NewMemAuthorityCache(func() time.Time { return now })
	r, sign, closeSrv := staleVerifierRealm(t, cache, now)
	defer closeSrv()

	_ = cache.MarkStale(context.Background(), "01HUSER", now.Add(-30*time.Second), now.Add(15*time.Minute))

	fresh := sign(map[string]any{
		"iss": r.BaseURL() + "/" + testRealmID, "sub": "01HUSER", "aud": testAud,
		"iat": now.Unix(), "exp": now.Add(15 * time.Minute).Unix(),
	})
	if _, err := r.Verify(context.Background(), fresh, nil); err != nil {
		t.Fatalf("the refreshed token was rejected by the marker that caused the refresh: %v\n"+
			"this is an unbounded refresh loop, which ADR-107 C5 calls a worse outcome "+
			"than the 900s window it closes", err)
	}
}

// D9: the comparison carries the verifier's existing `leeway`, the same way
// exp/nbf already do. One skew story for the whole verifier, not a second one
// invented here.
func TestVerify_StaleCheckCarriesTheVerifierLeeway(t *testing.T) {
	now := time.Now()
	cache := NewMemAuthorityCache(func() time.Time { return now })
	sign, pub := mintKey(t, "kid-1")
	srv := fakeServer(t, map[string][]jwk{testRealmID: {pub}}, testAud)
	defer srv.Close()
	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk_live_test", BaseURL: srv.URL,
		Authority: cache,
		Clock:     func() time.Time { return now },
		Leeway:    60 * time.Second,
	})

	// iat sits 30s BEHIND the marker — inside the 60s leeway, so it passes.
	_ = cache.MarkStale(context.Background(), "01HUSER", now, now.Add(15*time.Minute))
	tok := sign(map[string]any{
		"iss": srv.URL + "/" + testRealmID, "sub": "01HUSER", "aud": testAud,
		"iat": now.Add(-30 * time.Second).Unix(), "exp": now.Add(15 * time.Minute).Unix(),
	})
	if _, err := r.Verify(context.Background(), tok, nil); err != nil {
		t.Errorf("a token inside the configured 60s leeway was rejected: %v", err)
	}
}

// Fail-closed, exactly as the jti check does — but as `unauthorized`, NOT as
// token_stale. Answering token_stale on a cache OUTAGE would tell every client
// to refresh, which is the loop again, this time triggered by an unrelated
// dependency.
func TestVerify_AuthorityCacheErrorFailsClosedAsUnauthorized(t *testing.T) {
	now := time.Now()
	r, sign, closeSrv := staleVerifierRealm(t, errAuthorityCache{}, now)
	defer closeSrv()

	tok := sign(map[string]any{
		"iss": r.BaseURL() + "/" + testRealmID, "sub": "01HUSER", "aud": testAud,
		"iat": now.Unix(), "exp": now.Add(15 * time.Minute).Unix(),
	})
	_, err := r.Verify(context.Background(), tok, nil)
	if err == nil {
		t.Fatal("a cache error let the request through — the check does not fail closed")
	}
	if IsTokenStale(err) {
		t.Fatal("a cache outage answered token_stale — every client would refresh, " +
			"which is C5's loop with a different trigger")
	}
	if !IsCode(err, ErrCodeUnauthorized) {
		t.Errorf("code = %v, want unauthorized", err)
	}
}

// Opt-in, like the revocation cache: no Authority configured → the verifier
// behaves exactly as it did before ADR-107.
func TestVerify_NoAuthorityCacheIsANoOp(t *testing.T) {
	now := time.Now()
	r, sign, closeSrv := staleVerifierRealm(t, nil, now)
	defer closeSrv()
	tok := sign(map[string]any{
		"iss": r.BaseURL() + "/" + testRealmID, "sub": "01HUSER", "aud": testAud,
		"iat": now.Add(-time.Hour).Unix(), "exp": now.Add(15 * time.Minute).Unix(),
	})
	if _, err := r.Verify(context.Background(), tok, nil); err != nil {
		t.Fatalf("verifier changed behaviour with no cache configured: %v", err)
	}
}

type errAuthorityCache struct{}

func (errAuthorityCache) MarkStale(_ context.Context, _ string, _, _ time.Time) error {
	return errors.New("backend down")
}
func (errAuthorityCache) StaleSince(_ context.Context, _ string) (time.Time, bool, error) {
	return time.Time{}, false, errors.New("backend down")
}

// ---- D13, the loop-breaker -------------------------------------------------

// A forced refresh is honoured at most ONCE per token. D8 makes the loop very
// unlikely; D13 makes it impossible. It lives in the client SDK because that is
// where the retry decision is actually made.
func TestTokenManager_HandleStaleRefreshesOncePerToken(t *testing.T) {
	var mints int
	srv := mwTestServer(t, nil, testAud, map[string]http.HandlerFunc{
		"/auth/token": func(w http.ResponseWriter, _ *http.Request) {
			mints++
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "atok-fresh", "refresh_token": "rtok2", "expires_in": 900,
			})
		},
	})
	defer srv.Close()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	tm := r.Auth.NewTokenManager("rtok")

	fresh, err := tm.HandleStale(context.Background(), "atok-stale")
	if err != nil {
		t.Fatalf("first HandleStale: %v", err)
	}
	if fresh != "atok-fresh" {
		t.Fatalf("HandleStale returned %q, want the refreshed token", fresh)
	}
	if mints != 1 {
		t.Fatalf("mints = %d, want exactly 1", mints)
	}

	// The replay came back token_stale AGAIN, on a token minted AFTER the
	// refresh. That is a hard failure, not another refresh.
	_, err = tm.HandleStale(context.Background(), fresh)
	if err == nil {
		t.Fatal("a second token_stale on a post-refresh token refreshed again — " +
			"this is the unbounded loop D13 exists to make impossible")
	}
	if !IsTokenStale(err) {
		t.Errorf("hard failure should surface as token_stale, got %v", err)
	}
	if mints != 1 {
		t.Errorf("mints = %d after the hard failure, want still 1 — the manager hit "+
			"the issuer again", mints)
	}
}

// ---- D12: the refresh and logout lanes are never gated ---------------------
//
// DERIVED from MiddlewareOptions, not hand-written. The exclusion set is the
// set of auth-ingress `*Path` fields the middleware declares; a fifth one added
// tomorrow fails this test on the day it is written. This is the same rule as
// derived_claims_lanes_test.go, one layer up — and for the same reason: the
// hand-maintained list is how the fourth lane shipped ungated.
//
// A gated refresh lane leaves a demoted user no way back: their only route to a
// narrower token is the very call the marker is refusing.
func TestMiddlewareIngressLanesAreDerivedAndUngated(t *testing.T) {
	declared := ingressPathFields(t)
	if len(declared) < 4 {
		t.Fatalf("found %d ingress *Path fields on MiddlewareOptions (%v) — there are at "+
			"least LoginPath/LogoutPath/RefreshPath/MFAVerifyPath, so the detection is "+
			"broken and this guard checks nothing", len(declared), declared)
	}

	// Every declared ingress lane must be exercised below. A new field with no
	// entry here is a lane nobody proved is ungated.
	exercised := map[string]string{
		"LoginPath":     "/login",
		"LogoutPath":    "/logout",
		"RefreshPath":   "/token",
		"MFAVerifyPath": "/mfa/verify",
	}
	var unexercised []string
	for _, f := range declared {
		if _, ok := exercised[f]; !ok {
			unexercised = append(unexercised, f)
		}
	}
	if len(unexercised) > 0 {
		t.Fatalf("MiddlewareOptions declares ingress lanes this guard does not drive: %v\n"+
			"Add each to `exercised` and prove it still answers while its subject is "+
			"marked stale — an ungated proof is the whole of D12.", unexercised)
	}

	sign, pub := mintTestKey(t, "kid-1")
	loginBody := map[string]any{
		"access_token": "atok", "refresh_token": "rtok", "expires_in": 900,
		"user": map[string]any{"id": "01HUSER"}, "tenants": []any{},
	}
	srv := mwTestServer(t, []jwk{pub}, testAud, map[string]http.HandlerFunc{
		"/auth/login": func(w http.ResponseWriter, _ *http.Request) { _ = json.NewEncoder(w).Encode(loginBody) },
		"/auth/token": func(w http.ResponseWriter, _ *http.Request) { _ = json.NewEncoder(w).Encode(loginBody) },
		"/auth/logout": func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
		},
		"/auth/mfa/verify": func(w http.ResponseWriter, _ *http.Request) { _ = json.NewEncoder(w).Encode(loginBody) },
	})
	defer srv.Close()

	now := time.Now()
	cache := NewMemAuthorityCache(func() time.Time { return now })
	// The caller is demoted: their subject is marked stale for the whole test.
	_ = cache.MarkStale(context.Background(), "01HUSER", now, now.Add(15*time.Minute))

	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
		Authority: cache, Clock: func() time.Time { return now },
	})
	mw := r.Middleware(MiddlewareOptions{TokenDelivery: "body"})
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))

	// A stale token, presented on every lane.
	stale := sign(map[string]any{
		"iss": srv.URL + "/" + testRealmID, "sub": "01HUSER", "aud": testAud,
		"iat": now.Add(-10 * time.Minute).Unix(), "exp": now.Add(5 * time.Minute).Unix(),
	})

	bodies := map[string]string{
		"/login":      `{"grant_type":"provider_token","provider_token":"pt"}`,
		"/logout":     `{"refresh_token":"rtok"}`,
		"/token":      `{"refresh_token":"rtok"}`,
		"/mfa/verify": `{"mfa_challenge_token":"ct","code":"000000"}`,
	}
	for field, path := range exercised {
		t.Run(field, func(t *testing.T) {
			req := httptest.NewRequest("POST", path, strings.NewReader(bodies[path]))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+stale)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if strings.Contains(rec.Body.String(), string(ErrCodeTokenStale)) {
				t.Fatalf("%s answered token_stale (%d %s) — a demoted user's only route "+
					"back to a narrower token is refused, so they are locked out",
					path, rec.Code, rec.Body.String())
			}
		})
	}

	// The control. Without it, every assertion above is satisfied by a stale
	// check that never fires at all.
	req := httptest.NewRequest("GET", "/anything-else", nil)
	req.Header.Set("Authorization", "Bearer "+stale)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if !strings.Contains(rec.Body.String(), string(ErrCodeTokenStale)) {
		t.Fatalf("a protected route did NOT answer token_stale (%d %s) — the check is "+
			"inert and the lane assertions above pass vacuously", rec.Code, rec.Body.String())
	}
}

// ingressPathFields reads the auth-ingress lane names off MiddlewareOptions.
// String fields whose name ends in "Path": ExemptPaths is a []string and
// MFAProtectedPaths a []MFARule, so neither is an ingress lane.
func ingressPathFields(t *testing.T) []string {
	t.Helper()
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, filepath.Join(".", "middleware.go"), nil, 0)
	if err != nil {
		t.Fatalf("parse middleware.go: %v", err)
	}
	var out []string
	ast.Inspect(f, func(n ast.Node) bool {
		ts, ok := n.(*ast.TypeSpec)
		if !ok || ts.Name.Name != "MiddlewareOptions" {
			return true
		}
		st, ok := ts.Type.(*ast.StructType)
		if !ok {
			return false
		}
		for _, fld := range st.Fields.List {
			id, ok := fld.Type.(*ast.Ident)
			if !ok || id.Name != "string" {
				continue
			}
			for _, nm := range fld.Names {
				if strings.HasSuffix(nm.Name, "Path") {
					out = append(out, nm.Name)
				}
			}
		}
		return false
	})
	if _, err := os.Stat("middleware.go"); err != nil {
		t.Fatalf("middleware.go missing — guard would pass vacuously: %v", err)
	}
	sort.Strings(out)
	return out
}
