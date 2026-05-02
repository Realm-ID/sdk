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

// TestAuth_ListSessions_OnBehalfOf covers the BFF path: UserID set →
// platform-token bearer + X-On-Behalf-Of-User header, and the SPA-IP
// attribution header rides through unchanged.
func TestAuth_ListSessions_OnBehalfOf(t *testing.T) {
	var gotAuth, gotOBO, gotOBOIP string
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/sessions": func(w http.ResponseWriter, r *http.Request) {
			gotAuth = r.Header.Get("Authorization")
			gotOBO = r.Header.Get("X-On-Behalf-Of-User")
			gotOBOIP = r.Header.Get("X-On-Behalf-Of-IP")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items":       []any{map[string]any{"id": "sess-1"}},
				"next_cursor": "",
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	var ids []string
	for s, err := range r.Auth.ListSessions(context.Background(), ListSessionsRequest{
		UserID:       "user-42",
		OnBehalfOfIP: "203.0.113.7",
	}) {
		if err != nil {
			t.Fatalf("list: %v", err)
		}
		ids = append(ids, s.ID)
	}
	if len(ids) != 1 || ids[0] != "sess-1" {
		t.Errorf("ids = %v", ids)
	}
	if gotAuth != "Bearer ptok" {
		t.Errorf("auth = %q (want platform token)", gotAuth)
	}
	if gotOBO != "user-42" {
		t.Errorf("X-On-Behalf-Of-User = %q", gotOBO)
	}
	if gotOBOIP != "203.0.113.7" {
		t.Errorf("X-On-Behalf-Of-IP = %q", gotOBOIP)
	}
}

// TestAuth_ListSessions_LegacyUserBearer covers the public-client path:
// UserBearer set → that JWT is the Authorization, no OBO header.
func TestAuth_ListSessions_LegacyUserBearer(t *testing.T) {
	var gotAuth, gotOBO string
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/sessions": func(w http.ResponseWriter, r *http.Request) {
			gotAuth = r.Header.Get("Authorization")
			gotOBO = r.Header.Get("X-On-Behalf-Of-User")
			_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{}, "next_cursor": ""})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	for _, err := range r.Auth.ListSessions(context.Background(), ListSessionsRequest{UserBearer: "u-jwt"}) {
		if err != nil {
			t.Fatalf("list: %v", err)
		}
	}
	if gotAuth != "Bearer u-jwt" {
		t.Errorf("auth = %q (want user bearer)", gotAuth)
	}
	if gotOBO != "" {
		t.Errorf("OBO header leaked in legacy path: %q", gotOBO)
	}
}

// TestAuth_ListSessions_RequiresUserSelector enforces that callers pass
// exactly one of UserID / UserBearer.
func TestAuth_ListSessions_RequiresUserSelector(t *testing.T) {
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: "http://unused"})
	saw := false
	for _, err := range r.Auth.ListSessions(context.Background(), ListSessionsRequest{}) {
		saw = true
		if err == nil {
			t.Fatal("expected error when neither UserID nor UserBearer set")
		}
		var re *RealmError
		if !errors.As(err, &re) || re.Code != ErrCodeBadRequest {
			t.Errorf("err = %v (want bad_request)", err)
		}
	}
	if !saw {
		t.Fatal("iterator never yielded")
	}
}

// TestAuth_RevokeSession_OnBehalfOf checks the same auth resolution on
// the DELETE path and that the session id is path-escaped.
func TestAuth_RevokeSession_OnBehalfOf(t *testing.T) {
	var gotPath, gotAuth, gotOBO string
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/sessions/sess+1": func(w http.ResponseWriter, r *http.Request) {
			gotPath = r.URL.Path
			gotAuth = r.Header.Get("Authorization")
			gotOBO = r.Header.Get("X-On-Behalf-Of-User")
			w.WriteHeader(http.StatusNoContent)
		},
	})
	defer srv.Close()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	if err := r.Auth.RevokeSession(context.Background(), RevokeSessionRequest{
		SessionID: "sess+1",
		UserID:    "u-7",
	}); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if gotPath != "/auth/sessions/sess+1" {
		t.Errorf("path = %q", gotPath)
	}
	if gotAuth != "Bearer ptok" || gotOBO != "u-7" {
		t.Errorf("headers: auth=%q obo=%q", gotAuth, gotOBO)
	}
}

// TestAuth_MFAVerify_OnBehalfOfIP threads SPA IP through the verify call.
func TestAuth_MFAVerify_OnBehalfOfIP(t *testing.T) {
	var gotIP string
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/mfa/verify": func(w http.ResponseWriter, r *http.Request) {
			gotIP = r.Header.Get("X-On-Behalf-Of-IP")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "atok", "refresh_token": "rtok", "expires_in": 900,
				"tenants": []any{},
			})
		},
	})
	defer srv.Close()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	if _, err := r.Auth.MFAVerify(context.Background(), MFAVerifyRequest{
		ChallengeToken: "ch", Code: "123456",
		OnBehalfOfIP: "198.51.100.5",
	}); err != nil {
		t.Fatalf("verify: %v", err)
	}
	if gotIP != "198.51.100.5" {
		t.Errorf("X-On-Behalf-Of-IP = %q", gotIP)
	}
}

// TestAuth_MintMFAChallenge_OnBehalfOfIP threads SPA IP through the
// challenge mint.
func TestAuth_MintMFAChallenge_OnBehalfOfIP(t *testing.T) {
	var gotIP string
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/mfa/challenge": func(w http.ResponseWriter, r *http.Request) {
			gotIP = r.Header.Get("X-On-Behalf-Of-IP")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"mfa_challenge_token": "ch-1", "methods": []any{"totp"},
			})
		},
	})
	defer srv.Close()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	tok, _, err := r.Auth.MintMFAChallenge(context.Background(), MFAChallengeRequest{
		AccessToken:  "u-jwt",
		OnBehalfOfIP: "198.51.100.9",
	})
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	if tok != "ch-1" {
		t.Errorf("token = %q", tok)
	}
	if gotIP != "198.51.100.9" {
		t.Errorf("X-On-Behalf-Of-IP = %q", gotIP)
	}
}
