package realmid

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// authTestServer wires the routes auth.go cares about. ADR-051: the
// platform-token bootstrap and the user login both live on /auth/login;
// we dispatch on `grant_type` inside the handler. The bootstrap mints
// access token "ptok" so existing assertions (Bearer ptok) still apply.
func authTestServer(t *testing.T, handlers map[string]http.HandlerFunc) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	userLogin := handlers["/auth/login"]
	delete(handlers, "/auth/login")
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = r.Body.Close()
		var probe struct {
			GrantType string `json:"grant_type"`
		}
		_ = json.Unmarshal(body, &probe)
		if probe.GrantType == "platform_api_key" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status":        "ok",
				"subject_type":  "platform",
				"refresh_token": "rtok-platform",
				"access_token":  "ptok",
				"expires_in":    300,
			})
			return
		}
		if userLogin == nil {
			http.Error(w, "no user login handler", http.StatusNotImplemented)
			return
		}
		// Re-prime body so the user handler sees what was sent.
		r.Body = io.NopCloser(bytes.NewReader(body))
		userLogin(w, r)
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
		Method:        LoginMicrosoft,
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
	// ADR-051: login speaks canonical grant_type=provider_token + provider,
	// NOT the deprecated `method` field (Sunset 2026-08-01). The LoginMethod
	// carries through as the provider hint.
	if gotBody["grant_type"] != "provider_token" {
		t.Errorf("grant_type = %v, want provider_token", gotBody["grant_type"])
	}
	if gotBody["provider"] != "microsoft" {
		t.Errorf("provider = %v, want microsoft", gotBody["provider"])
	}
	if gotBody["method"] != nil {
		t.Errorf("login must not send the deprecated `method` field, got: %v", gotBody["method"])
	}
	if gotBody["token"] != "pt-xyz" {
		t.Errorf("token = %v, want pt-xyz", gotBody["token"])
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

// TestAuth_DecodesRefreshExp locks the SPEC §4.1 refresh_exp wire field onto
// both the login (Session) and token (MintResult) responses. The BFF sizes a
// session's absolute TTL from this value instead of a local 30d guess, so a
// silent decode drop would resurrect the "session evicted while the refresh
// token is still valid" divergence (#10). Absence must decode as 0 so callers
// can fall back to their own ceiling against a pre-refresh_exp issuer.
func TestAuth_DecodesRefreshExp(t *testing.T) {
	const wantExp int64 = 1_780_000_000
	const wantIdle int64 = 1800 // ADR-070 sliding idle-timeout duration (seconds)
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/login": func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":  "atok",
				"refresh_token": "rtok",
				"expires_in":    900,
				"refresh_exp":   wantExp, // unix seconds, a JSON number
				"idle_ttl":      wantIdle,
				"user":          map[string]any{"id": "u1"},
				"tenants":       []any{map[string]any{"id": "t1", "role": "owner"}},
			})
		},
		"/auth/token": func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":  "atok2",
				"refresh_token": "rtok2",
				"expires_in":    900,
				"refresh_exp":   wantExp,
				"idle_ttl":      wantIdle,
				"tenant_id":     "t1",
				"role":          "owner",
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})

	sess, err := r.Auth.Login(context.Background(), LoginRequest{Method: LoginMicrosoft, ProviderToken: "pt"})
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if sess.RefreshExp != wantExp {
		t.Errorf("Session.RefreshExp = %d, want %d", sess.RefreshExp, wantExp)
	}
	if sess.IdleTTL != wantIdle {
		t.Errorf("Session.IdleTTL = %d, want %d", sess.IdleTTL, wantIdle)
	}

	mint, err := r.Auth.Token(context.Background(), TokenRequest{RefreshToken: "rtok", TenantID: "t1"})
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	if mint.RefreshExp != wantExp {
		t.Errorf("MintResult.RefreshExp = %d, want %d", mint.RefreshExp, wantExp)
	}
	if mint.IdleTTL != wantIdle {
		t.Errorf("MintResult.IdleTTL = %d, want %d", mint.IdleTTL, wantIdle)
	}

	// A response with no refresh_exp / idle_ttl must decode as 0 (fallback signal).
	srv2 := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/login": func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "a", "refresh_token": "rr", "expires_in": 900,
				"user": map[string]any{"id": "u1"}, "tenants": []any{map[string]any{"id": "t1"}},
			})
		},
	})
	defer srv2.Close()
	r2, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv2.URL})
	s2, err := r2.Auth.Login(context.Background(), LoginRequest{Method: LoginMicrosoft, ProviderToken: "pt"})
	if err != nil {
		t.Fatalf("login2: %v", err)
	}
	if s2.RefreshExp != 0 {
		t.Errorf("absent refresh_exp should decode as 0, got %d", s2.RefreshExp)
	}
	if s2.IdleTTL != 0 {
		t.Errorf("absent idle_ttl should decode as 0, got %d", s2.IdleTTL)
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
			// created_at / last_seen_at are unix-seconds JSON numbers on the wire —
			// assert both decode. CreatedAt was mistyped string pre-v0.22.0;
			// LastUsedAt read zero until the json tag was reconciled to the
			// issuer's `last_seen_at` field (not `last_used_at`).
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items": []any{map[string]any{
					"id":           "sess-1",
					"created_at":   1_751_241_600,
					"last_seen_at": 1_751_245_200,
				}},
				"next_cursor": "",
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	var ids []string
	var createdAt, lastUsedAt int64
	for s, err := range r.Auth.ListSessions(context.Background(), ListSessionsRequest{
		UserID:       "user-42",
		OnBehalfOfIP: "203.0.113.7",
	}) {
		if err != nil {
			t.Fatalf("list: %v", err)
		}
		ids = append(ids, s.ID)
		createdAt = s.CreatedAt
		lastUsedAt = s.LastUsedAt
	}
	if len(ids) != 1 || ids[0] != "sess-1" {
		t.Errorf("ids = %v", ids)
	}
	if createdAt != 1_751_241_600 {
		t.Errorf("CreatedAt = %d, want 1751241600 (unix seconds)", createdAt)
	}
	if lastUsedAt != 1_751_245_200 {
		t.Errorf("LastUsedAt = %d, want 1751245200 (decoded from wire last_seen_at)", lastUsedAt)
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

// TestSessionInfo_UnmarshalIssuerPayload is the drift regression guard: a
// representative issuer sessionDTO payload (which uses `last_seen_at`, NOT
// `last_used_at`) must populate SessionInfo.LastUsedAt via the struct json
// tag. Through go/v0.22.0 the tag read `last_used_at`, so LastUsedAt always
// decoded to zero even after the string→int64 fix.
func TestSessionInfo_UnmarshalIssuerPayload(t *testing.T) {
	// Mirrors issuer/internal/httpapi/sessions.go sessionDTO on the wire.
	payload := []byte(`{
		"id": "sess-9",
		"origin": "https://app.realmid.dev",
		"device_name": "laptop",
		"created_at": 1751241600,
		"last_seen_at": 1751245200
	}`)
	var si SessionInfo
	if err := json.Unmarshal(payload, &si); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if si.CreatedAt != 1_751_241_600 {
		t.Errorf("CreatedAt = %d, want 1751241600", si.CreatedAt)
	}
	if si.LastUsedAt != 1_751_245_200 {
		t.Errorf("LastUsedAt = %d, want 1751245200 — json tag must map to the issuer's last_seen_at field", si.LastUsedAt)
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

// TestLoginDeviceNameIsHeaderSafe pins that a label the transport cannot carry
// is stripped rather than fatal. net/http fails the whole request with
// "invalid header field value" on a C0 control (measured in a container, not
// assumed), so "send it raw and let the server sanitize" was wrong for exactly
// the input sanitizing exists for — the login never left the process. Found by
// tests/sdk-e2e driving a real issuer through the TS client; Go had the same
// hole since ADR-062. The 120-char CAP is deliberately NOT applied here.
func TestLoginDeviceNameIsHeaderSafe(t *testing.T) {
	longTail := strings.Repeat("x", 200)
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"control characters are removed", "rogue\nname" + longTail, "roguename" + longTail},
		{"an all-control label sends no header", "\n\n", ""},
		{"an ordinary label is untouched", "akshat-mbp", "akshat-mbp"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got string
			var seen bool
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/auth/login" {
					var body map[string]any
					_ = json.NewDecoder(r.Body).Decode(&body)
					if body["grant_type"] == "platform_api_key" {
						w.Header().Set("Content-Type", "application/json")
						_, _ = w.Write([]byte(`{"access_token":"pt","expires_in":300,"subject_type":"platform"}`))
						return
					}
					got = r.Header.Get("X-Device-Name")
					_, seen = r.Header["X-Device-Name"]
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(`{"access_token":"at","refresh_token":"rt","expires_in":600,"user":{"id":"u1"},"tenants":[]}`))
					return
				}
				w.WriteHeader(http.StatusNotFound)
			}))
			defer srv.Close()

			r, err := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
			if err != nil {
				t.Fatalf("NewRealm: %v", err)
			}
			if _, err := r.Auth.Login(context.Background(), LoginRequest{
				Method: LoginFirebase, ProviderToken: "tok", DeviceName: tc.in,
			}); err != nil {
				t.Fatalf("Login: %v (a stripped label must not fail the request)", err)
			}
			if got != tc.want {
				t.Errorf("X-Device-Name = %q, want %q", got, tc.want)
			}
			// An empty header is a SUPPLIED label as far as the issuer is
			// concerned, so the empty case must send no header at all.
			if tc.want == "" && seen {
				t.Errorf("X-Device-Name was sent as an empty header; it must be omitted")
			}
		})
	}
}

