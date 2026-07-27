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

// platform_token_test.go — the session manager after ADR-089.
//
// The three tests replaced here (LoginCacheRefresh, RefreshFallbackToLogin,
// ConcurrentRefreshSingleFlight) all drove /auth/token with a refresh token as
// the bearer. That endpoint no longer serves this identity: ADR-089 withdrew
// the refresh token from every credential-bootstrapped session, so the manager
// re-mints from the api key / workload assertion instead.

// platformLoginMux serves an ADR-089-shaped /auth/login: an access token and
// NO refresh_token. /auth/token is wired to fail the test outright — reaching
// it means the manager still believes in a refresh path.
func platformLoginMux(t *testing.T, loginCalls *atomic.Int32, gate <-chan struct{}) *http.ServeMux {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		if gate != nil {
			<-gate
		}
		n := loginCalls.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":       "ok",
			"subject_type": "platform",
			"access_token": "atok-" + string(rune('A'+n-1)),
			"expires_in":   60,
		})
	})
	mux.HandleFunc("/auth/token", func(w http.ResponseWriter, _ *http.Request) {
		t.Error("ADR-089: the session manager must not call /auth/token — a " +
			"credential-bootstrapped session has no refresh token")
		w.WriteHeader(http.StatusUnauthorized)
	})
	return mux
}

// TestSession_NoRefreshTokenInResponseStillWorks is the regression that matters
// most. The manager used to reject a login response whose refresh_token was
// empty ("platform login returned empty tokens"), so an SDK predating ADR-089
// does not degrade against a v0.68.0 issuer — it fails hard, on the very first
// call, taking the BFF with it.
func TestSession_NoRefreshTokenInResponseStillWorks(t *testing.T) {
	var loginCalls atomic.Int32
	srv := httptest.NewServer(platformLoginMux(t, &loginCalls, nil))
	defer srv.Close()

	r, err := NewRealm(Config{RealmID: testRealmID, APIKey: "rk_live_test", BaseURL: srv.URL})
	if err != nil {
		t.Fatalf("NewRealm: %v", err)
	}
	tok, err := r.platformToken.get(context.Background())
	if err != nil {
		t.Fatalf("login with no refresh_token must succeed: %v", err)
	}
	if tok != "atok-A" {
		t.Errorf("token: got %q", tok)
	}
}

// TestSession_LoginCacheRemint: cache while fresh, re-mint from the credential
// once inside the 30s window.
func TestSession_LoginCacheRemint(t *testing.T) {
	var loginCalls atomic.Int32
	srv := httptest.NewServer(platformLoginMux(t, &loginCalls, nil))
	defer srv.Close()

	r, err := NewRealm(Config{RealmID: testRealmID, APIKey: "rk_live_test", BaseURL: srv.URL})
	if err != nil {
		t.Fatalf("NewRealm: %v", err)
	}
	if _, err := r.platformToken.get(context.Background()); err != nil {
		t.Fatalf("first get: %v", err)
	}
	if loginCalls.Load() != 1 {
		t.Fatalf("login calls: got %d, want 1", loginCalls.Load())
	}

	// Cache hit — no second login.
	if _, err := r.platformToken.get(context.Background()); err != nil {
		t.Fatalf("cache get: %v", err)
	}
	if loginCalls.Load() != 1 {
		t.Errorf("expected a cache hit, got %d logins", loginCalls.Load())
	}

	// Inside the 30s window — re-mint. The credential travels again, which is
	// the deliberate ADR-089 trade: one login per access-token lifetime.
	r.platformToken.mu.Lock()
	r.platformToken.accessExpiresAt = time.Now().Add(15 * time.Second)
	r.platformToken.mu.Unlock()
	tok, err := r.platformToken.get(context.Background())
	if err != nil {
		t.Fatalf("re-mint get: %v", err)
	}
	if tok != "atok-B" {
		t.Errorf("re-minted token: got %q, want atok-B", tok)
	}
	if loginCalls.Load() != 2 {
		t.Errorf("expected a second login, got %d", loginCalls.Load())
	}
}

// TestSession_ConcurrentRemintSingleFlight verifies that N goroutines racing on
// an expired access token collapse into ONE /auth/login. Without single-flight
// each would mint its own platform session row — cheap per call, but it turns
// every token expiry into a burst proportional to concurrency.
func TestSession_ConcurrentRemintSingleFlight(t *testing.T) {
	var loginCalls atomic.Int32
	release := make(chan struct{})
	// The seed login must not block, so gate only after it has happened.
	gated := make(chan struct{})
	var seeded atomic.Bool
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		if seeded.Load() {
			<-release
		}
		n := loginCalls.Add(1)
		if n == 1 {
			seeded.Store(true)
			close(gated)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":       "ok",
			"subject_type": "platform",
			"access_token": "atok-" + string(rune('A'+n-1)),
			"expires_in":   60,
		})
	})
	mux.HandleFunc("/auth/token", func(w http.ResponseWriter, _ *http.Request) {
		t.Error("ADR-089: no /auth/token call expected")
		w.WriteHeader(http.StatusUnauthorized)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, err := NewRealm(Config{RealmID: testRealmID, APIKey: "rk_live_test", BaseURL: srv.URL})
	if err != nil {
		t.Fatalf("NewRealm: %v", err)
	}
	if _, err := r.platformToken.get(context.Background()); err != nil {
		t.Fatalf("seed login: %v", err)
	}
	<-gated
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
	// Let the racers all pile into acquire() and block, then release the one
	// in-flight login. Without single-flight this deterministically produces
	// concurrent logins.
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()

	for i := 0; i < n; i++ {
		if errs[i] != nil {
			t.Fatalf("get[%d]: %v", i, errs[i])
		}
		if toks[i] != "atok-B" {
			t.Errorf("get[%d]: got %q, want atok-B", i, toks[i])
		}
	}
	if loginCalls.Load() != 2 {
		t.Errorf("expected exactly 2 logins (seed + one single-flighted re-mint), got %d", loginCalls.Load())
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
