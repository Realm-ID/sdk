package realmid

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// authTestServer wires the routes auth.go cares about.
func authTestServer(t *testing.T, handlers map[string]http.HandlerFunc) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/platform-token", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"platform_token": "ptok", "expires_in": 300})
	})
	mux.HandleFunc("/platforms/mine", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []any{
				map[string]any{"id": testRealmID, "audience": testAud},
			},
		})
	})
	for p, h := range handlers {
		mux.HandleFunc(p, h)
	}
	return httptest.NewServer(mux)
}

func TestAuth_LoginHappy(t *testing.T) {
	var gotBody map[string]any
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/login": func(w http.ResponseWriter, r *http.Request) {
			buf, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(buf, &gotBody)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":  "atok",
				"refresh_token": "rtok",
				"expires_in":    900,
				"user":          map[string]any{"id": "u1"},
				"tenants":       []any{map[string]any{"id": "t1", "role": "owner"}},
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.Auth.Login(context.Background(), LoginRequest{
		Method:        LoginFirebase,
		ProviderToken: "pt-xyz",
	})
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if out.AccessToken != "atok" || out.RefreshToken != "rtok" {
		t.Errorf("tokens: %+v", out)
	}
	if gotBody["realm_id"] != testRealmID {
		t.Errorf("server got body: %+v", gotBody)
	}
	if gotBody["custom_claims"] != nil {
		t.Errorf("login must not send custom_claims (SPEC §4.1)")
	}
}

func TestAuth_LoginMFARequiredEnvelope(t *testing.T) {
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/login": func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusPreconditionFailed)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error":               map[string]any{"code": "mfa_required", "message": "MFA required"},
				"mfa_challenge_token": "ct-123",
				"methods":             []string{"totp"},
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	_, err := r.Auth.Login(context.Background(), LoginRequest{Method: LoginFirebase, ProviderToken: "pt"})
	var re *RealmError
	if !errors.As(err, &re) {
		t.Fatalf("expected RealmError, got %v", err)
	}
	if re.Code != ErrCodeMFARequired {
		t.Errorf("code: got %s", re.Code)
	}
	if re.Details["mfa_challenge_token"] != "ct-123" {
		t.Errorf("details mfa_challenge_token: %+v", re.Details)
	}
}

func TestAuth_TokenWithCustomClaims(t *testing.T) {
	var gotBody map[string]any
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/token": func(w http.ResponseWriter, r *http.Request) {
			buf, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(buf, &gotBody)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":  "atok2",
				"refresh_token": "rtok2",
				"expires_in":    900,
				"tenant_id":     "t1",
				"role":          "owner",
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.Auth.Token(context.Background(), TokenRequest{
		RefreshToken: "rtok",
		TenantID:     "t1",
		CustomClaims: map[string]any{"outlet_ids": []string{"o1", "o2"}},
	})
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	if out.AccessToken != "atok2" {
		t.Errorf("access: %s", out.AccessToken)
	}
	if cc, _ := gotBody["custom_claims"].(map[string]any); cc == nil || cc["outlet_ids"] == nil {
		t.Errorf("server should have received custom_claims, got: %+v", gotBody)
	}
}

func TestAuth_Logout(t *testing.T) {
	called := false
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/logout": func(w http.ResponseWriter, _ *http.Request) {
			called = true
			w.WriteHeader(http.StatusNoContent)
		},
	})
	defer srv.Close()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	if err := r.Auth.Logout(context.Background(), &LogoutRequest{RefreshToken: "rt"}); err != nil {
		t.Fatalf("logout: %v", err)
	}
	if !called {
		t.Fatal("server not called")
	}
}
