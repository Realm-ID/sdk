package realmid

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestSession_LoginCacheRefresh covers the ADR-051 two-endpoint flow:
// first call hits /auth/login, subsequent in-window calls hit cache,
// near-expiry calls hit /auth/token.
func TestSession_LoginCacheRefresh(t *testing.T) {
	var loginCalls, tokenCalls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		loginCalls.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":        "ok",
			"subject_type":  "platform",
			"refresh_token": "rtok-1",
			"access_token":  "atok-fresh",
			"expires_in":    60,
		})
	})
	mux.HandleFunc("/auth/token", func(w http.ResponseWriter, _ *http.Request) {
		tokenCalls.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":        "ok",
			"subject_type":  "platform",
			"refresh_token": "rtok-1", // non-rotating realm
			"access_token":  "atok-rotated",
			"expires_in":    60,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, err := NewRealm(Config{RealmID: testRealmID, APIKey: "rk_live_test", BaseURL: srv.URL})
	if err != nil {
		t.Fatalf("NewRealm: %v", err)
	}

	tok, err := r.platformToken.get(context.Background())
	if err != nil {
		t.Fatalf("first get: %v", err)
	}
	if tok != "atok-fresh" {
		t.Errorf("token: got %q", tok)
	}
	if loginCalls.Load() != 1 {
		t.Errorf("login calls: got %d", loginCalls.Load())
	}

	// Cache hit — no second login, no /auth/token.
	if _, err := r.platformToken.get(context.Background()); err != nil {
		t.Fatalf("cache get: %v", err)
	}
	if loginCalls.Load() != 1 || tokenCalls.Load() != 0 {
		t.Errorf("expected cache hit; login=%d token=%d", loginCalls.Load(), tokenCalls.Load())
	}

	// Force expiry to within 30s window — should refresh via /auth/token.
	r.platformToken.mu.Lock()
	r.platformToken.accessExpiresAt = time.Now().Add(15 * time.Second)
	r.platformToken.mu.Unlock()
	tok, err = r.platformToken.get(context.Background())
	if err != nil {
		t.Fatalf("refresh get: %v", err)
	}
	if tok != "atok-rotated" {
		t.Errorf("rotated token: got %q", tok)
	}
	if tokenCalls.Load() != 1 {
		t.Errorf("expected /auth/token call, got %d", tokenCalls.Load())
	}
	if loginCalls.Load() != 1 {
		t.Errorf("login should not be re-called when refresh works: %d", loginCalls.Load())
	}
}

// TestSession_RefreshFallbackToLogin covers the case where /auth/token
// returns 401 (refresh revoked / rotated) — manager must fall back to
// /auth/login transparently.
func TestSession_RefreshFallbackToLogin(t *testing.T) {
	var loginCalls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		loginCalls.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":        "ok",
			"subject_type":  "platform",
			"refresh_token": "rtok-" + string(rune('A'+loginCalls.Load()-1)),
			"access_token":  "atok-" + string(rune('A'+loginCalls.Load()-1)),
			"expires_in":    60,
		})
	})
	mux.HandleFunc("/auth/token", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{"code": "unauthorized", "message": "refresh revoked"},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk_live_test", BaseURL: srv.URL})
	if _, err := r.platformToken.get(context.Background()); err != nil {
		t.Fatalf("first login: %v", err)
	}
	// Force the access into the refresh window so the next get() tries
	// /auth/token first.
	r.platformToken.mu.Lock()
	r.platformToken.accessExpiresAt = time.Now().Add(5 * time.Second)
	r.platformToken.mu.Unlock()
	if _, err := r.platformToken.get(context.Background()); err != nil {
		t.Fatalf("fallback login: %v", err)
	}
	if loginCalls.Load() != 2 {
		t.Errorf("expected 2 logins (initial + fallback), got %d", loginCalls.Load())
	}
}

// TestSession_ConcurrentRefreshSingleFlight verifies that N goroutines
// racing on an expired access token collapse into a single /auth/token
// call. Without single-flight they would each replay the same one-time-use
// refresh token, and the issuer would reject all but the first as reuse —
// killing the session.
func TestSession_ConcurrentRefreshSingleFlight(t *testing.T) {
	var loginCalls, tokenCalls atomic.Int32
	release := make(chan struct{})
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		loginCalls.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":        "ok",
			"subject_type":  "platform",
			"refresh_token": "rtok-1",
			"access_token":  "atok-fresh",
			"expires_in":    60,
		})
	})
	mux.HandleFunc("/auth/token", func(w http.ResponseWriter, _ *http.Request) {
		// Block until all racers have piled up, so a missing single-flight
		// would deterministically produce multiple concurrent calls.
		<-release
		tokenCalls.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":        "ok",
			"subject_type":  "platform",
			"refresh_token": "rtok-2",
			"access_token":  "atok-rotated",
			"expires_in":    60,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, err := NewRealm(Config{RealmID: testRealmID, APIKey: "rk_live_test", BaseURL: srv.URL})
	if err != nil {
		t.Fatalf("NewRealm: %v", err)
	}
	// Seed the session, then push it into the refresh window.
	if _, err := r.platformToken.get(context.Background()); err != nil {
		t.Fatalf("seed login: %v", err)
	}
	r.platformToken.mu.Lock()
	r.platformToken.accessExpiresAt = time.Now().Add(5 * time.Second)
	r.platformToken.mu.Unlock()

	const n = 16
	toks := make([]string, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			toks[i], errs[i] = r.platformToken.get(context.Background())
		}(i)
	}
	// Give the racers time to all enter acquire() and block on /auth/token,
	// then let the single in-flight request complete.
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()

	for i := 0; i < n; i++ {
		if errs[i] != nil {
			t.Fatalf("get[%d]: %v", i, errs[i])
		}
		if toks[i] != "atok-rotated" {
			t.Errorf("get[%d]: got %q, want atok-rotated", i, toks[i])
		}
	}
	if tokenCalls.Load() != 1 {
		t.Errorf("expected exactly 1 /auth/token call, got %d", tokenCalls.Load())
	}
	if loginCalls.Load() != 1 {
		t.Errorf("expected no re-login (only the seed), got %d login calls", loginCalls.Load())
	}
}

func TestSession_UnauthorizedSurfaces(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{"code": "unauthorized", "message": "bad api key"},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk_live_test", BaseURL: srv.URL})
	_, err := r.platformToken.get(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
	if !IsCode(err, ErrCodeUnauthorized) {
		t.Errorf("expected unauthorized, got %v", err)
	}
}
