package realmid

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

// middleware_derived_claims_test.go — the REFRESH lane must resolve the derived
// claims, exactly as the login lanes do.
//
// # The defect these guard
//
// `mintProductRoles` ran on login lanes only. Nothing ran on refresh, and the middleware's
// own refresh minted with `{RefreshToken, TenantID, CustomClaims}` only. So a
// BFF-fronted session carried `product_roles` at login and lost it roughly one
// access-TTL later, for the life of the session. `scope` had the identical hole,
// which is what blocked a partner's ADR-097 cutover.
//
// `product_roles.go` promised the opposite in writing the whole time: "It runs
// on EVERY mint, refresh included, and nothing caches."
//
// ⚠️ THESE TESTS ARE LANE-SPECIFIC ON PURPOSE. An assertion that "a login
// carries the claim" passed throughout the entire life of the bug. The lane is
// the subject, not the claim.
//
// ⚠️ AND THE LANE SET IS NOT WRITTEN DOWN HERE ANY MORE. This comment used to
// name "three call sites — Login, CompleteLogin, PasswordLogin". It was true
// when written, and it is how MFAVerify AND OTPLogin later shipped handing back
// claim-blind sessions with every test in this file green. The set now comes
// from the package AST — see derived_claims_lanes_test.go. Do not re-introduce
// a list here.

// refreshCapture records every /auth/token body the middleware sends.
type refreshCapture struct {
	mu     sync.Mutex
	bodies []map[string]any
}

func (c *refreshCapture) add(b map[string]any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.bodies = append(c.bodies, b)
}

func (c *refreshCapture) snapshot() []map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]map[string]any, len(c.bodies))
	copy(out, c.bodies)
	return out
}

// last returns the body of the FINAL mint — the one whose token the caller
// actually ends up holding. Asserting on the first would pass while the claim
// was dropped from the token that gets used.
func (c *refreshCapture) last() map[string]any {
	all := c.snapshot()
	if len(all) == 0 {
		return nil
	}
	return all[len(all)-1]
}

// refreshServer serves /auth/token with a real signed access token, so the SDK
// can recover the subject from it the way the fix must.
func refreshServer(t *testing.T, cap *refreshCapture) (*httptest.Server, func() string) {
	t.Helper()
	sign, pub := mintTestKey(t, "kid-1")
	now := time.Now().Unix()
	var issuer string
	srv := mwTestServer(t, []jwk{pub}, testAud, map[string]http.HandlerFunc{
		"/auth/token": func(w http.ResponseWriter, r *http.Request) {
			buf, _ := io.ReadAll(r.Body)
			var body map[string]any
			_ = json.Unmarshal(buf, &body)
			cap.add(body)
			access := sign(map[string]any{
				"iss": issuer, "sub": "u-refresh", "aud": testAud,
				"iat": now, "exp": now + 600,
			})
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": access, "refresh_token": "rtok2",
				"expires_in": 900, "subject_type": "user",
				"tenant_id": "t1", "role": "member",
			})
		},
	})
	return srv, func() string { return issuer }
}

// driveRefresh runs one refresh request through the middleware.
func driveRefresh(t *testing.T, r *Realm) {
	t.Helper()
	mw := r.Middleware(MiddlewareOptions{})
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) }))
	req := httptest.NewRequest("POST", "/token", strings.NewReader(`{"tenant_id":"t1"}`))
	req.AddCookie(&http.Cookie{Name: "realmid_refresh", Value: "rtok"})
	h.ServeHTTP(httptest.NewRecorder(), req)
}

// THE REGRESSION TEST. Red before the fix: the refresh minted without ever
// calling the handler, so `product_roles` was absent from the wire.
func TestDerivedClaims_RefreshResolvesProductRoles(t *testing.T) {
	cap := &refreshCapture{}
	srv, setIssuer := refreshServer(t, cap)
	defer srv.Close()
	_ = setIssuer

	var sawTenant, sawUser string
	var handlerCalls int
	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
		ProductRoles: func(_ context.Context, tenantID, userID string) ([]string, error) {
			handlerCalls++
			sawTenant, sawUser = tenantID, userID
			return []string{"dispatch"}, nil
		},
	})
	driveRefresh(t, r)

	if handlerCalls == 0 {
		t.Fatalf("the product_roles handler was never called on the REFRESH lane — " +
			"product_roles.go promises it 'runs on EVERY mint, refresh included'")
	}
	if sawTenant != "t1" {
		t.Errorf("handler tenantID = %q, want t1", sawTenant)
	}
	// The subject must come from the token, not be invented or left blank: a
	// handler that resolves roles for the empty user is a silent wrong answer.
	if sawUser != "u-refresh" {
		t.Errorf("handler userID = %q, want u-refresh (recovered from the minted token's sub)", sawUser)
	}
	last := cap.last()
	if last == nil {
		t.Fatal("no /auth/token call was made at all")
	}
	roles, _ := last["product_roles"].([]any)
	if len(roles) != 1 || roles[0] != "dispatch" {
		t.Errorf("product_roles on the FINAL mint = %#v, want [dispatch]", last["product_roles"])
	}
}

// The same lane, the same hole, for ADR-097 granted authority. This is the one
// that blocked a partner: with `scope` absent, ScopesFrom reads nil and every
// ScopePolicy gate denies about one access-TTL into every session.
func TestDerivedClaims_RefreshResolvesScopes(t *testing.T) {
	cap := &refreshCapture{}
	srv, _ := refreshServer(t, cap)
	defer srv.Close()

	var sawTenant, sawUser string
	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
		Scopes: func(_ context.Context, tenantID, userID string) ([]string, error) {
			sawTenant, sawUser = tenantID, userID
			return []string{"invoices:read", "invoices:write"}, nil
		},
	})
	driveRefresh(t, r)

	if sawTenant != "t1" || sawUser != "u-refresh" {
		t.Errorf("scopes handler got (%q,%q), want (t1,u-refresh)", sawTenant, sawUser)
	}
	last := cap.last()
	if last == nil {
		t.Fatal("no /auth/token call was made at all")
	}
	// Space-delimited on the wire (ADR-097), not an array — the issuer's
	// `scope` claim is a string and `ScopesFrom` splits on fields.
	if got, _ := last["scope"].(string); got != "invoices:read invoices:write" {
		t.Errorf("scope on the FINAL mint = %#v, want the two scopes space-delimited", last["scope"])
	}
}

// COST GUARD, and it is the assertion most likely to rot. The re-mint is a
// SECOND round trip, so a consumer who adopts neither handler must keep paying
// for exactly one. Asserting only the body would let the extra call creep in
// unnoticed — this asserts the COUNT.
func TestDerivedClaims_NoHandlerMintsExactlyOnce(t *testing.T) {
	cap := &refreshCapture{}
	srv, _ := refreshServer(t, cap)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	driveRefresh(t, r)

	if n := len(cap.snapshot()); n != 1 {
		t.Errorf("with no handler configured the refresh must mint exactly once, got %d", n)
	}
	if b := cap.last(); b != nil {
		if _, present := b["product_roles"]; present {
			t.Error("product_roles must be absent, not empty, when no handler is configured")
		}
		if _, present := b["scope"]; present {
			t.Error("scope must be absent, not empty, when no handler is configured")
		}
	}
}

// An empty result mints NO claim, not `[]`. Absent and empty must mean the same
// thing for these two, because every token issued before the feature has no
// claim at all and a reader handles absence regardless.
//
// ⚠️ This rule is NOT shared by role_permissions, where an empty non-nil list is
// a real instruction the issuer answers with a 403. Do not harmonise them.
func TestDerivedClaims_EmptyResultMintsNoClaim(t *testing.T) {
	cap := &refreshCapture{}
	srv, _ := refreshServer(t, cap)
	defer srv.Close()

	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
		ProductRoles: func(_ context.Context, _, _ string) ([]string, error) {
			return []string{}, nil
		},
		Scopes: func(_ context.Context, _, _ string) ([]string, error) {
			return nil, nil
		},
	})
	driveRefresh(t, r)

	b := cap.last()
	if b == nil {
		t.Fatal("no mint")
	}
	if _, present := b["product_roles"]; present {
		t.Errorf("an empty handler result must mint NO product_roles claim, got %#v", b["product_roles"])
	}
	if _, present := b["scope"]; present {
		t.Errorf("a nil handler result must mint NO scope claim, got %#v", b["scope"])
	}
}

// The MIRROR of the refresh bug, and the reason this file does not stop at the
// refresh lane. `Config.Scopes` that worked on refresh but not on login would
// reproduce the exact defect being fixed, pointed the other way — and it would
// be found the same way: by a partner, in production.
//
// mintProductRoles is the shared mint for every session-producing lane, so
// proving it here proves the login side of the seam.
func TestDerivedClaims_LoginResolvesScopes(t *testing.T) {
	var got map[string]any
	var calls int32
	srv := loginThenTokenServer(t, &got, &calls)
	defer srv.Close()

	var sawTenant, sawUser string
	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
		Scopes: func(_ context.Context, tenantID, userID string) ([]string, error) {
			sawTenant, sawUser = tenantID, userID
			return []string{"invoices:read"}, nil
		},
	})
	if _, err := r.Auth.Login(context.Background(), LoginRequest{ProviderToken: "pt"}); err != nil {
		t.Fatalf("login: %v", err)
	}
	if sawTenant != "t1" || sawUser != "u1" {
		t.Errorf("scopes handler got (%q,%q), want (t1,u1)", sawTenant, sawUser)
	}
	if s, _ := got["scope"].(string); s != "invoices:read" {
		t.Errorf("scope on the login mint = %#v, want invoices:read", got["scope"])
	}
}

// A Scopes handler alone must be enough to trigger the login mint. The guard in
// mintProductRoles short-circuits when no handler is set and a token is already
// in hand; if it only ever consulted ProductRoles, a scopes-only consumer would
// silently never mint at all.
func TestDerivedClaims_ScopesOnlyStillMintsOnLogin(t *testing.T) {
	var got map[string]any
	var calls int32
	srv := loginThenTokenServer(t, &got, &calls)
	defer srv.Close()

	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
		Scopes: func(_ context.Context, _, _ string) ([]string, error) {
			return []string{"invoices:read"}, nil
		},
	})
	if _, err := r.Auth.Login(context.Background(), LoginRequest{ProviderToken: "pt"}); err != nil {
		t.Fatalf("login: %v", err)
	}
	if calls != 1 {
		t.Fatalf("a scopes-only consumer must still mint on login, got %d mints", calls)
	}
}

// The handler's error refuses the mint and HANDS BACK the session, so the caller
// can recover rather than losing a login that actually succeeded.
func TestDerivedClaims_ScopesHandlerErrorRefusesTheMint(t *testing.T) {
	var got map[string]any
	var calls int32
	srv := loginThenTokenServer(t, &got, &calls)
	defer srv.Close()

	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
		Scopes: func(_ context.Context, _, _ string) ([]string, error) {
			return nil, errScopesBoom
		},
	})
	_, err := r.Auth.Login(context.Background(), LoginRequest{ProviderToken: "pt"})
	if err == nil {
		t.Fatal("a failing scopes handler must refuse the mint, not mint without the claim")
	}
	var lm *LoginMintError
	if !errors.As(err, &lm) {
		t.Fatalf("want a *LoginMintError carrying the session back, got %T: %v", err, err)
	}
	var se *ScopesError
	if !errors.As(err, &se) {
		t.Fatalf("want a *ScopesError underneath, got %v", err)
	}
	if se.Attempts != productRolesAttempts {
		t.Errorf("attempts = %d, want the shared retry budget %d", se.Attempts, productRolesAttempts)
	}
	if lm.Session == nil {
		t.Error("the session must travel on the error — the login itself succeeded")
	}
}

var errScopesBoom = errors.New("scope store down")
