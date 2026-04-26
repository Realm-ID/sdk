package realmid

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func mwTestServer(t *testing.T, jwks []jwk, audience string, extra map[string]http.HandlerFunc) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/platform-token", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"platform_token": "ptok", "expires_in": 300})
	})
	mux.HandleFunc("/platforms/mine", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []any{map[string]any{"id": testRealmID, "audience": audience}},
		})
	})
	mux.HandleFunc("/"+testRealmID+"/.well-known/jwks.json", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(jwksDoc{Keys: jwks})
	})
	for p, h := range extra {
		mux.HandleFunc(p, h)
	}
	return httptest.NewServer(mux)
}

func mintTestKey(t *testing.T, kid string) (signFn, jwk) {
	t.Helper()
	priv, _ := rsa.GenerateKey(rand.Reader, 2048)
	pub := priv.PublicKey
	pj := jwk{
		Kty: "RSA", Kid: kid, Alg: "RS256", Use: "sig",
		N: base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
		E: base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes()),
	}
	sign := func(claims map[string]any) string {
		hb, _ := json.Marshal(map[string]any{"alg": "RS256", "typ": "JWT", "kid": kid})
		cb, _ := json.Marshal(claims)
		signing := base64.RawURLEncoding.EncodeToString(hb) + "." + base64.RawURLEncoding.EncodeToString(cb)
		sum := sha256.Sum256([]byte(signing))
		sig, _ := rsa.SignPKCS1v15(rand.Reader, priv, crypto.SHA256, sum[:])
		return signing + "." + base64.RawURLEncoding.EncodeToString(sig)
	}
	return sign, pj
}

func TestMiddleware_ExemptPathPasses(t *testing.T) {
	srv := mwTestServer(t, nil, testAud, nil)
	defer srv.Close()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	mw := r.Middleware(MiddlewareOptions{ExemptPaths: []string{"/health"}})

	called := false
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(200)
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/health", nil))
	if !called {
		t.Fatal("exempt path should pass through")
	}
}

func TestMiddleware_LoginRouteHandledBySDK(t *testing.T) {
	srv := mwTestServer(t, nil, testAud, map[string]http.HandlerFunc{
		"/auth/login": func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "atok", "refresh_token": "rtok", "expires_in": 900,
				"user": map[string]any{"id": "u1"}, "tenants": []any{},
			})
		},
	})
	defer srv.Close()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	mw := r.Middleware(MiddlewareOptions{TokenDelivery: "body"})
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) }))

	body := strings.NewReader(`{"method":"firebase","provider_token":"pt"}`)
	req := httptest.NewRequest("POST", "/login", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status: %d body: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["access_token"] != "atok" {
		t.Errorf("response: %+v", out)
	}
}

func TestMiddleware_Unauthenticated401(t *testing.T) {
	srv := mwTestServer(t, nil, testAud, nil)
	defer srv.Close()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	mw := r.Middleware(MiddlewareOptions{})
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/me", nil))
	if rec.Code != 401 {
		t.Errorf("status: %d", rec.Code)
	}
}

func TestMiddleware_ValidBearerAttachesClaims(t *testing.T) {
	sign, pub := mintTestKey(t, "kid-1")
	srv := mwTestServer(t, []jwk{pub}, testAud, nil)
	defer srv.Close()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	mw := r.Middleware(MiddlewareOptions{})

	now := time.Now().Unix()
	tok := sign(map[string]any{
		"iss": srv.URL + "/" + testRealmID,
		"sub": "u1", "aud": testAud, "iat": now, "exp": now + 600,
	})

	var got *Claims
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		got, _ = ClaimsFrom(req.Context())
		w.WriteHeader(200)
	}))
	req := httptest.NewRequest("GET", "/me", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status: %d body: %s", rec.Code, rec.Body.String())
	}
	if got == nil || got.Subject != "u1" {
		t.Errorf("claims: %+v", got)
	}
}

func TestMiddleware_MFAProtected412(t *testing.T) {
	sign, pub := mintTestKey(t, "kid-1")
	srv := mwTestServer(t, []jwk{pub}, testAud, nil)
	defer srv.Close()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	mw := r.Middleware(MiddlewareOptions{MFAProtectedPaths: []MFARule{{Path: "/admin/*"}}})

	now := time.Now().Unix()
	tok := sign(map[string]any{
		"iss": srv.URL + "/" + testRealmID,
		"sub": "u1", "aud": testAud, "iat": now, "exp": now + 600,
		// no amr/acr
	})
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	req := httptest.NewRequest("GET", "/admin/users", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusPreconditionFailed {
		t.Fatalf("status: %d body: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	envelope, _ := out["error"].(map[string]any)
	if envelope == nil || envelope["code"] != "mfa_required" {
		t.Errorf("envelope: %+v", out)
	}
}

func TestMiddleware_GlobMatcher(t *testing.T) {
	cases := []struct {
		pat, path string
		want      bool
	}{
		{"/health", "/health", true},
		{"/health", "/healthx", false},
		{"/public/*", "/public/x", true},
		{"/public/*", "/public/x/y", false},
		{"/public/**", "/public/x/y", true},
		{"/public/**", "/public", true},
	}
	for _, c := range cases {
		got := globToRegex(c.pat).MatchString(c.path)
		if got != c.want {
			t.Errorf("glob %q vs %q: got %v want %v", c.pat, c.path, got, c.want)
		}
	}
}

// TestLoggerRedactsCredentials verifies §9 — raw API keys never appear
// in log output.
func TestLoggerRedactsCredentials(t *testing.T) {
	var buf strings.Builder
	logger := newCapturingLogger(&buf)
	srv := mwTestServer(t, nil, testAud, nil)
	defer srv.Close()
	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk_live_supersecret", BaseURL: srv.URL,
		Logger: logger,
	})
	// Trigger a platform-token mint (logs at info).
	_, _ = r.platformToken.get(context.Background())
	out := buf.String()
	if out == "" {
		t.Fatal("no logs captured")
	}
	if strings.Contains(out, "supersecret") {
		t.Errorf("raw API key leaked into logs:\n%s", out)
	}
}

func newCapturingLogger(w io.Writer) *slogLogger {
	return slog.New(slog.NewTextHandler(w, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

type slogLogger = slog.Logger

func TestMiddleware_MFAFresh_AcceptsWithinMaxAge(t *testing.T) {
	sign, pub := mintTestKey(t, "kid-1")
	srv := mwTestServer(t, []jwk{pub}, testAud, nil)
	defer srv.Close()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	mw := r.Middleware(MiddlewareOptions{
		MFAProtectedPaths: []MFARule{{Path: "/admin/*", MaxAge: 15 * time.Minute}},
	})
	now := time.Now().Unix()
	tok := sign(map[string]any{
		"iss": srv.URL + "/" + testRealmID,
		"sub": "u1", "aud": testAud, "iat": now, "exp": now + 600,
		"mfa_at": now - 60, // 1 minute ago
	})
	called := false
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { called = true; w.WriteHeader(200) }))
	req := httptest.NewRequest("GET", "/admin/users", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if !called {
		t.Fatalf("handler not called: status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestMiddleware_MFAStale_Returns412StaleReason(t *testing.T) {
	sign, pub := mintTestKey(t, "kid-1")
	srv := mwTestServer(t, []jwk{pub}, testAud, nil)
	defer srv.Close()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	mw := r.Middleware(MiddlewareOptions{
		MFAProtectedPaths: []MFARule{{Path: "/admin/*", MaxAge: 15 * time.Minute}},
	})
	now := time.Now().Unix()
	tok := sign(map[string]any{
		"iss": srv.URL + "/" + testRealmID,
		"sub": "u1", "aud": testAud, "iat": now, "exp": now + 600,
		"mfa_at": now - 1800, // 30 minutes ago — stale
	})
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	req := httptest.NewRequest("GET", "/admin/users", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusPreconditionFailed {
		t.Fatalf("status: %d", rec.Code)
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["reason"] != "stale_mfa" {
		t.Errorf("reason: %v", out["reason"])
	}
	if out["max_age_seconds"] != float64(900) {
		t.Errorf("max_age_seconds: %v", out["max_age_seconds"])
	}
}

func TestMiddleware_RequireFresh_RejectsLegacyMarker(t *testing.T) {
	sign, pub := mintTestKey(t, "kid-1")
	srv := mwTestServer(t, []jwk{pub}, testAud, nil)
	defer srv.Close()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	mw := r.Middleware(MiddlewareOptions{
		MFAProtectedPaths: []MFARule{{Path: "/billing/*", RequireFresh: true}},
	})
	now := time.Now().Unix()
	tok := sign(map[string]any{
		"iss": srv.URL + "/" + testRealmID,
		"sub": "u1", "aud": testAud, "iat": now, "exp": now + 600,
		"amr": []string{"pwd", "mfa"}, // legacy marker, no mfa_at
	})
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	req := httptest.NewRequest("POST", "/billing/charge", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusPreconditionFailed {
		t.Fatalf("status: %d", rec.Code)
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["reason"] != "fresh_required" {
		t.Errorf("reason: %v", out["reason"])
	}
}

func TestMiddleware_RequireFresh_AcceptsRecentMfaAt(t *testing.T) {
	sign, pub := mintTestKey(t, "kid-1")
	srv := mwTestServer(t, []jwk{pub}, testAud, nil)
	defer srv.Close()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	mw := r.Middleware(MiddlewareOptions{
		MFAProtectedPaths: []MFARule{{Path: "/billing/*", RequireFresh: true}},
	})
	now := time.Now().Unix()
	tok := sign(map[string]any{
		"iss": srv.URL + "/" + testRealmID,
		"sub": "u1", "aud": testAud, "iat": now, "exp": now + 600,
		"mfa_at": now - 5, // 5 sec ago — within RequireFresh window
	})
	called := false
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { called = true; w.WriteHeader(200) }))
	req := httptest.NewRequest("POST", "/billing/charge", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if !called {
		t.Fatalf("handler not called: status=%d body=%s", rec.Code, rec.Body.String())
	}
}
