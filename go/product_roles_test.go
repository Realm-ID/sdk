package realmid

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// product_roles_test.go — ADR-102 D10/D11 in the Go SDK.

// loginThenTokenServer serves a single-tenant login plus /auth/token, recording
// what the mint received.
func loginThenTokenServer(t *testing.T, capture *map[string]any, calls *int32) *httptest.Server {
	t.Helper()
	return authTestServer(t, map[string]http.HandlerFunc{
		"/auth/login": func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"refresh_token": "rtok",
				"user":          map[string]any{"id": "u1"},
				"tenants":       []any{map[string]any{"tenant_id": "t1", "role": "owner"}},
			})
		},
		"/auth/token": func(w http.ResponseWriter, r *http.Request) {
			atomic.AddInt32(calls, 1)
			buf, _ := io.ReadAll(r.Body)
			var body map[string]any
			_ = json.Unmarshal(buf, &body)
			*capture = body
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":  "minted",
				"refresh_token": "rtok2",
				"expires_in":    900,
			})
		},
	})
}

// D10 — a single-tenant login MINTS, and the handler's output rides the mint.
func TestProductRoles_SingleTenantLoginMints(t *testing.T) {
	var got map[string]any
	var calls int32
	srv := loginThenTokenServer(t, &got, &calls)
	defer srv.Close()

	var sawTenant, sawUser string
	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
		ProductRoles: func(_ context.Context, tenantID, userID string) ([]string, error) {
			sawTenant, sawUser = tenantID, userID
			return []string{"dispatch", "Regional Manager"}, nil
		},
	})
	s, err := r.Auth.Login(context.Background(), LoginRequest{ProviderToken: "pt"})
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if calls != 1 {
		t.Fatalf("want exactly one /auth/token mint, got %d", calls)
	}
	if sawTenant != "t1" || sawUser != "u1" {
		t.Errorf("handler got (%q,%q), want (t1,u1)", sawTenant, sawUser)
	}
	roles, _ := got["product_roles"].([]any)
	if len(roles) != 2 || roles[0] != "dispatch" || roles[1] != "Regional Manager" {
		t.Errorf("product_roles on the wire = %#v, want the handler's list verbatim "+
			"(a space is legitimate — this is NOT the RFC 6749 scope charset)", got["product_roles"])
	}
	// The session carries the MINTED token, not login's.
	if s.AccessToken != "minted" || s.RefreshToken != "rtok2" {
		t.Errorf("session must carry the minted tokens, got %+v", s)
	}
	if s.TenantID != "t1" {
		t.Errorf("the settled tenant must land on the session, got %q", s.TenantID)
	}
}

// D10 — a MULTI-tenant login does NOT mint. The caller chooses, then completes.
//
// ⚠️ The failure this guards is silent: auto-picking Tenants[0] would mint for
// an arbitrary org and resolve THAT org's roles — a wrong answer, not an error.
func TestProductRoles_MultiTenantLoginDoesNotMint(t *testing.T) {
	var got map[string]any
	var calls int32
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/login": func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"refresh_token": "rtok",
				"user":          map[string]any{"id": "u1"},
				"tenants": []any{
					map[string]any{"tenant_id": "t1", "role": "member"},
					map[string]any{"tenant_id": "t2", "role": "owner"},
				},
			})
		},
		"/auth/token": func(w http.ResponseWriter, r *http.Request) {
			atomic.AddInt32(&calls, 1)
			buf, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(buf, &got)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "minted-t2", "refresh_token": "rtok2", "expires_in": 900,
			})
		},
	})
	defer srv.Close()

	var handlerTenants []string
	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
		ProductRoles: func(_ context.Context, tenantID, _ string) ([]string, error) {
			handlerTenants = append(handlerTenants, tenantID)
			return []string{"role-of-" + tenantID}, nil
		},
	})
	s, err := r.Auth.Login(context.Background(), LoginRequest{ProviderToken: "pt"})
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if calls != 0 {
		t.Fatalf("a multi-tenant login must NOT mint; got %d /auth/token calls", calls)
	}
	if len(handlerTenants) != 0 {
		t.Fatalf("the handler must not run before a tenant is chosen; it saw %v", handlerTenants)
	}
	if !s.NeedsTenantChoice() {
		t.Fatal("NeedsTenantChoice must report the picker")
	}

	// The caller chooses t2 — deliberately NOT Tenants[0], so an auto-pick
	// would be visible here rather than passing by coincidence.
	if err := r.Auth.CompleteLogin(context.Background(), s, "t2", nil); err != nil {
		t.Fatalf("CompleteLogin: %v", err)
	}
	if calls != 1 {
		t.Fatalf("CompleteLogin must mint exactly once, got %d", calls)
	}
	if len(handlerTenants) != 1 || handlerTenants[0] != "t2" {
		t.Errorf("the handler must run for the CHOSEN tenant, saw %v", handlerTenants)
	}
	if roles, _ := got["product_roles"].([]any); len(roles) != 1 || roles[0] != "role-of-t2" {
		t.Errorf("minted %#v, want the chosen tenant's roles", got["product_roles"])
	}
	if s.TenantID != "t2" || s.Role != "owner" {
		t.Errorf("the chosen tenant and its role must land on the session, got %q/%q",
			s.TenantID, s.Role)
	}
}

// CompleteLogin refuses a tenant the session does not hold, LOCALLY.
//
// The issuer would answer invalid_credentials, which reads as a login failure
// rather than as the caller bug it is.
func TestProductRoles_CompleteLoginRefusesAnUnheldTenant(t *testing.T) {
	s := &Session{Tenants: []TenantRef{{ID: "t1"}, {ID: "t2"}}}
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: "http://127.0.0.1:1"})
	if err := r.Auth.CompleteLogin(context.Background(), s, "t9", nil); err == nil {
		t.Fatal("a tenant the session does not list must be refused before the request leaves")
	}
	if err := r.Auth.CompleteLogin(context.Background(), s, "", nil); err == nil {
		t.Fatal("an empty tenant must be refused: the multi-tenant branch does not auto-pick")
	}
}

// D11 rule 1 — NO handler configured means the claim is omitted, no error, and
// no extra round trip when login already minted.
func TestProductRoles_NoHandlerIsNotAnError(t *testing.T) {
	var calls int32
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/login": func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":  "atok",
				"refresh_token": "rtok",
				"expires_in":    900,
				"user":          map[string]any{"id": "u1"},
				"tenants":       []any{map[string]any{"tenant_id": "t1", "role": "owner"}},
			})
		},
		"/auth/token": func(w http.ResponseWriter, r *http.Request) {
			atomic.AddInt32(&calls, 1)
			w.WriteHeader(http.StatusInternalServerError)
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	s, err := r.Auth.Login(context.Background(), LoginRequest{ProviderToken: "pt"})
	if err != nil {
		t.Fatalf("a login with no handler must succeed unchanged: %v", err)
	}
	if calls != 0 {
		t.Errorf("no handler + an access token already in hand must cost NO extra round "+
			"trip; got %d", calls)
	}
	if s.AccessToken != "atok" {
		t.Errorf("the login's own token must survive, got %q", s.AccessToken)
	}
}

// D11 rule 2 — empty or nil mints NO claim, not [].
func TestProductRoles_EmptyMintsNoClaim(t *testing.T) {
	for _, tc := range []struct {
		name  string
		roles []string
	}{
		{"nil", nil},
		{"empty", []string{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var got map[string]any
			var calls int32
			srv := loginThenTokenServer(t, &got, &calls)
			defer srv.Close()
			r, _ := NewRealm(Config{
				RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
				ProductRoles: func(context.Context, string, string) ([]string, error) {
					return tc.roles, nil
				},
			})
			if _, err := r.Auth.Login(context.Background(), LoginRequest{ProviderToken: "pt"}); err != nil {
				t.Fatalf("login: %v", err)
			}
			if _, present := got["product_roles"]; present {
				t.Errorf("an empty handler result must mint NO claim, not []; wire carried %#v",
					got["product_roles"])
			}
		})
	}
}

// D11 rule 3 — an error RETRIES, then REFUSES the mint, and the error is the
// PARTNER'S.
func TestProductRoles_HandlerErrorRetriesThenRefuses(t *testing.T) {
	var got map[string]any
	var mints int32
	srv := loginThenTokenServer(t, &got, &mints)
	defer srv.Close()

	var attempts int32
	boom := errors.New("role db unavailable")
	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
		ProductRoles: func(context.Context, string, string) ([]string, error) {
			atomic.AddInt32(&attempts, 1)
			return nil, boom
		},
	})
	start := time.Now()
	_, err := r.Auth.Login(context.Background(), LoginRequest{ProviderToken: "pt"})
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("a failing handler must REFUSE the mint. Minting anyway says 'this " +
			"principal has no product roles', which is indistinguishable from the truth " +
			"for a principal who genuinely has none — a silent under-grant")
	}
	if attempts != productRolesAttempts {
		t.Errorf("want %d attempts (initial + 2 retries), got %d", productRolesAttempts, attempts)
	}
	if mints != 0 {
		t.Errorf("the mint must not be attempted after the handler gave up, got %d", mints)
	}

	// The error is YOURS and says so. "Your role handler failed 3 times" and
	// "RealmID refused your mint" are different incidents.
	var pre *ProductRolesError
	if !errors.As(err, &pre) {
		t.Fatalf("want *ProductRolesError, got %T: %v", err, err)
	}
	if !errors.Is(err, boom) {
		t.Error("the partner's own error must be unwrappable from it")
	}
	var re *RealmError
	if errors.As(err, &re) {
		t.Error("a handler failure must NOT be mapped into a RealmError — that would " +
			"make the partner's outage look like ours")
	}
	// The backoff is BOUNDED: ~50ms + ~150ms. This asserts the ceiling, because
	// the login hot path has a human waiting on it.
	if elapsed > 2*time.Second {
		t.Errorf("the retry budget must be bounded (~200ms of backoff); took %v", elapsed)
	}
}

// D11 — a cancelled context abandons immediately rather than burning the
// remaining attempts. A retry loop that outlives its caller is a server-side
// pileup.
func TestProductRoles_CancelledContextAbandons(t *testing.T) {
	var got map[string]any
	var mints int32
	srv := loginThenTokenServer(t, &got, &mints)
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	var attempts int32
	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
		ProductRoles: func(context.Context, string, string) ([]string, error) {
			atomic.AddInt32(&attempts, 1)
			cancel()
			return nil, errors.New("boom")
		},
	})
	if _, err := r.Auth.Login(ctx, LoginRequest{ProviderToken: "pt"}); err == nil {
		t.Fatal("want an error")
	}
	if attempts != 1 {
		t.Errorf("a cancelled context must stop after the first attempt, got %d", attempts)
	}
}

// ADR-102 OQ8 — the session is the RECOVERY ANCHOR and rides on the error.
//
// ⚠️ This is the assertion that keeps the split honest. Returning (nil, err) is
// the obvious Go shape and would silently drop the anchor, because every caller
// writes `if err != nil { return nil, err }` — and the users stranded by that
// are exactly the ones ADR-092's session-limit affordance and ADR-061's
// enrollment gate exist for.
func TestProductRoles_MintFailureHandsBackTheSession(t *testing.T) {
	var got map[string]any
	var mints int32
	srv := loginThenTokenServer(t, &got, &mints)
	defer srv.Close()

	boom := errors.New("role db unavailable")
	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
		ProductRoles: func(context.Context, string, string) ([]string, error) {
			return nil, boom
		},
	})
	_, err := r.Auth.Login(context.Background(), LoginRequest{ProviderToken: "pt"})
	if err == nil {
		t.Fatal("want an error")
	}
	var lme *LoginMintError
	if !errors.As(err, &lme) {
		t.Fatalf("want *LoginMintError carrying the session, got %T: %v", err, err)
	}
	if lme.Session == nil {
		t.Fatal("the session must ride on the error — it is the recovery anchor")
	}
	if lme.Session.RefreshToken != "rtok" {
		t.Errorf("the anchor must carry a usable refresh token, got %q", lme.Session.RefreshToken)
	}
	if lme.TenantID != "t1" {
		t.Errorf("the error must name the tenant the mint was attempted for, got %q", lme.TenantID)
	}
	// The partner's own error is still reachable through the wrapper.
	if !errors.Is(err, boom) {
		t.Error("the underlying handler error must remain unwrappable")
	}
	var pre *ProductRolesError
	if !errors.As(err, &pre) {
		t.Error("the ProductRolesError must remain reachable: 'your handler failed' and " +
			"'RealmID refused' are different incidents")
	}
}
