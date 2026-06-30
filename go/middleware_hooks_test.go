package realmid

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// captureLogin returns a /auth/login handler that records the decoded
// request body and replies with a fixed single-tenant session.
func captureLogin(into *map[string]any) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, into)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "atok", "refresh_token": "rtok", "expires_in": 900,
			"tenant_id": "t1", "role": "owner",
			"user":    map[string]any{"id": "u1", "display_name": "User One"},
			"tenants": []any{map[string]any{"tenant_id": "t1", "role": "owner", "display_name": "Tenant One"}},
		})
	}
}

// ADR-065 item 4 (tenant_id passthrough) + item 2 (BeforeLogin mutation).
func TestMiddleware_TenantIDForwarded_AndBeforeLoginMutates(t *testing.T) {
	var seen map[string]any
	srv := mwTestServer(t, nil, testAud, map[string]http.HandlerFunc{
		"/auth/login": captureLogin(&seen),
	})
	defer srv.Close()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})

	mw := r.Middleware(MiddlewareOptions{
		TokenDelivery: "body",
		BeforeLogin: func(_ context.Context, req *LoginRequest) error {
			req.ProviderToken = "swapped-key" // sync-install substitution
			return nil
		},
	})
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) }))

	body := strings.NewReader(`{"method":"firebase","provider_token":"orig","tenant_id":"t1"}`)
	req := httptest.NewRequest("POST", "/login", body)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	if seen["tenant_id"] != "t1" {
		t.Errorf("tenant_id not forwarded to issuer: %+v", seen)
	}
	// LoginRequest.ProviderToken serializes to the wire field "token".
	if seen["token"] != "swapped-key" {
		t.Errorf("BeforeLogin mutation not applied: %+v", seen)
	}
}

// ADR-065 item 1: OnAuthSuccess fires on login with the normalized payload.
func TestMiddleware_OnAuthSuccess_Login(t *testing.T) {
	var ignore map[string]any
	srv := mwTestServer(t, nil, testAud, map[string]http.HandlerFunc{
		"/auth/login": captureLogin(&ignore),
	})
	defer srv.Close()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})

	var got *AuthSuccessEvent
	mw := r.Middleware(MiddlewareOptions{
		TokenDelivery: "body",
		OnAuthSuccess: func(_ context.Context, ev *AuthSuccessEvent) error { got = ev; return nil },
	})
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) }))

	req := httptest.NewRequest("POST", "/login", strings.NewReader(`{"method":"firebase","provider_token":"p"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	if got == nil {
		t.Fatal("OnAuthSuccess not fired")
	}
	if got.Flow != FlowLogin || got.UserID != "u1" || got.TenantID != "t1" || got.Role != "owner" {
		t.Errorf("event: %+v", got)
	}
	if got.Session == nil || len(got.Tenants) != 1 {
		t.Errorf("session/tenants not populated on login path: %+v", got)
	}
}

// ADR-065 item 1 / Q-4: on refresh, MintResult has no user object, so the
// SDK recovers UserID by verifying the freshly-minted access token's sub.
func TestMiddleware_OnAuthSuccess_Refresh_RecoversUserIDViaVerify(t *testing.T) {
	sign, pub := mintTestKey(t, "kid-1")
	now := time.Now().Unix()

	var issuer string // set after the server starts; read at request time
	srv := mwTestServer(t, []jwk{pub}, testAud, map[string]http.HandlerFunc{
		"/auth/token": func(w http.ResponseWriter, _ *http.Request) {
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
	defer srv.Close()
	issuer = srv.URL + "/" + testRealmID

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	var got *AuthSuccessEvent
	mw := r.Middleware(MiddlewareOptions{
		OnAuthSuccess: func(_ context.Context, ev *AuthSuccessEvent) error { got = ev; return nil },
	})
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) }))

	req := httptest.NewRequest("POST", "/token", strings.NewReader(`{"tenant_id":"t1"}`))
	req.AddCookie(&http.Cookie{Name: "realmid_refresh", Value: "rtok"})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	if got == nil || got.Flow != FlowRefresh {
		t.Fatalf("event: %+v", got)
	}
	if got.UserID != "u-refresh" {
		t.Errorf("UserID not recovered via verify: %q", got.UserID)
	}
	if got.Claims == nil || got.Claims.Subject != "u-refresh" {
		t.Errorf("claims not attached: %+v", got.Claims)
	}
}

// ADR-065 Q-1: a non-nil OnAuthSuccess fails the request — no cookie set,
// downstream not reached.
func TestMiddleware_OnAuthSuccess_FailsClosed_NoCookie(t *testing.T) {
	var ignore map[string]any
	var failEv *AuthFailureEvent
	srv := mwTestServer(t, nil, testAud, map[string]http.HandlerFunc{
		"/auth/login": captureLogin(&ignore),
	})
	defer srv.Close()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})

	mw := r.Middleware(MiddlewareOptions{
		// cookie mode (default) so we can assert no Set-Cookie leaks
		OnAuthSuccess: func(_ context.Context, _ *AuthSuccessEvent) error {
			return &RealmError{Code: ErrCodeServerError, Message: "reconcile failed", HTTPStatus: 500}
		},
		OnAuthFailure: func(_ context.Context, ev *AuthFailureEvent) { failEv = ev },
	})
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) }))

	req := httptest.NewRequest("POST", "/login", strings.NewReader(`{"method":"firebase","provider_token":"p"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != 500 {
		t.Fatalf("expected 500, got %d body %s", rec.Code, rec.Body.String())
	}
	if sc := rec.Header().Get("Set-Cookie"); sc != "" {
		t.Errorf("refresh cookie leaked on failed reconcile: %q", sc)
	}
	if failEv == nil || failEv.Stage != stageOnSuccess {
		t.Errorf("OnAuthFailure not observed with on_success stage: %+v", failEv)
	}
}

// ADR-065 Q-2 (forced On): missing Origin is rejected with missing_origin.
func TestMiddleware_OriginEnforcement_On_RejectsMissingOrigin(t *testing.T) {
	var ignore map[string]any
	srv := mwTestServer(t, nil, testAud, map[string]http.HandlerFunc{
		"/auth/login": captureLogin(&ignore),
	})
	defer srv.Close()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})

	mw := r.Middleware(MiddlewareOptions{
		TokenDelivery:     "body",
		OriginEnforcement: OriginEnforcementOn,
	})
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) }))

	req := httptest.NewRequest("POST", "/login", strings.NewReader(`{"method":"firebase","provider_token":"p"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d body %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	env, _ := out["error"].(map[string]any)
	if env == nil || env["code"] != "missing_origin" {
		t.Errorf("envelope: %+v", out)
	}
}

// ADR-065 Q-2 (forced On): an allowlisted Origin is admitted.
func TestMiddleware_OriginEnforcement_On_AllowsListedOrigin(t *testing.T) {
	var ignore map[string]any
	srv := mwTestServer(t, nil, testAud, map[string]http.HandlerFunc{
		"/auth/login": captureLogin(&ignore),
		"/platforms/" + testRealmID + "/origins": func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items": []any{map[string]any{"domain": "https://app.example.com"}},
			})
		},
	})
	defer srv.Close()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})

	mw := r.Middleware(MiddlewareOptions{
		TokenDelivery:     "body",
		OriginEnforcement: OriginEnforcementOn,
	})
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) }))

	req := httptest.NewRequest("POST", "/login", strings.NewReader(`{"method":"firebase","provider_token":"p"}`))
	req.Header.Set("Origin", "https://app.example.com")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("allowlisted origin should pass, got %d body %s", rec.Code, rec.Body.String())
	}
}

// ADR-065 Q-2 (Auto): enforcement follows realm.Info().OriginEnforcement.
func TestMiddleware_OriginEnforcement_Auto_FollowsRealmPolicy(t *testing.T) {
	var ignore map[string]any
	srv := mineServerWithOrigin(t, testAud, "required", captureLogin(&ignore))
	defer srv.Close()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})

	mw := r.Middleware(MiddlewareOptions{TokenDelivery: "body"}) // Auto (default)
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) }))

	req := httptest.NewRequest("POST", "/login", strings.NewReader(`{"method":"firebase","provider_token":"p"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("Auto mode should enforce per realm policy, got %d body %s", rec.Code, rec.Body.String())
	}
}

// mineServerWithOrigin is a minimal issuer whose /platforms/mine carries an
// origin_enforcement policy, for exercising OriginEnforcementAuto.
func mineServerWithOrigin(t *testing.T, audience, originEnforcement string, login http.HandlerFunc) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		_ = r.Body.Close()
		var probe struct {
			GrantType string `json:"grant_type"`
		}
		_ = json.Unmarshal(b, &probe)
		if probe.GrantType == "platform_api_key" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status": "ok", "subject_type": "platform",
				"refresh_token": "rp", "access_token": "ptok", "expires_in": 300,
			})
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(b))
		login(w, r)
	})
	mux.HandleFunc("/platforms/mine", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []any{map[string]any{
				"id": testRealmID, "audience": audience, "origin_enforcement": originEnforcement,
			}},
		})
	})
	return httptest.NewServer(mux)
}
