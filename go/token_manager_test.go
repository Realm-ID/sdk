package realmid

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// tmServer stands up a fake issuer for TokenManager tests. /auth/login
// serves the platform bearer (NewTokenManager → AuthClient.Token →
// platformToken.get); /auth/token is the user-refresh endpoint under test.
// tokenHandler receives the presented refresh token (from the body) and
// the per-call sequence number.
func tmServer(t *testing.T, tokenHandler func(w http.ResponseWriter, presentedRefresh string, n int32)) (*Realm, *atomic.Int32) {
	t.Helper()
	var tokenCalls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "ok", "subject_type": "platform",
			"refresh_token": "rtok-plat", "access_token": "atok-plat", "expires_in": 3600,
		})
	})
	mux.HandleFunc("/auth/token", func(w http.ResponseWriter, r *http.Request) {
		n := tokenCalls.Add(1)
		var body struct {
			RefreshToken string `json:"refresh_token"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		tokenHandler(w, body.RefreshToken, n)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	r, err := NewRealm(Config{RealmID: testRealmID, APIKey: "rk_live_test", BaseURL: srv.URL})
	if err != nil {
		t.Fatalf("NewRealm: %v", err)
	}
	return r, &tokenCalls
}

func rotatingTokenHandler(w http.ResponseWriter, _ string, n int32) {
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status": "ok", "subject_type": "user",
		"refresh_token": fmt.Sprintf("rtok-user-%d", n),
		"access_token":  fmt.Sprintf("atok-user-%d", n),
		"expires_in":    3600, "tenant_id": "tnt-1", "role": "member",
	})
}

// TestTokenManager_CacheThenRefresh: first AccessToken refreshes, the
// next returns cache, and a near-expiry one refreshes again.
func TestTokenManager_CacheThenRefresh(t *testing.T) {
	r, tokenCalls := tmServer(t, rotatingTokenHandler)
	mgr := r.Auth.NewTokenManager("rtok-seed", WithTokenManagerTenant("tnt-1"))

	tok, err := mgr.AccessToken(context.Background())
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	if tok != "atok-user-1" {
		t.Errorf("first token: got %q", tok)
	}
	if tokenCalls.Load() != 1 {
		t.Errorf("token calls: got %d want 1", tokenCalls.Load())
	}
	// Cache hit — no extra /auth/token.
	if _, err := mgr.AccessToken(context.Background()); err != nil {
		t.Fatalf("cache: %v", err)
	}
	if tokenCalls.Load() != 1 {
		t.Errorf("expected cache hit; token calls=%d", tokenCalls.Load())
	}
	// Force near-expiry → refresh, presenting the rotated token.
	mgr.mu.Lock()
	mgr.accessExpiresAt = time.Now().Add(15 * time.Second)
	mgr.mu.Unlock()
	tok, err = mgr.AccessToken(context.Background())
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if tok != "atok-user-2" {
		t.Errorf("refreshed token: got %q", tok)
	}
	if got := mgr.RefreshToken(); got != "rtok-user-2" {
		t.Errorf("rotated refresh: got %q", got)
	}
}

// TestTokenManager_SinkPersistBeforeReturn: the sink is called with the
// rotated token, and its value is durably visible before AccessToken
// returns (we assert ordering by reading what the sink saw).
func TestTokenManager_SinkPersistBeforeReturn(t *testing.T) {
	r, _ := tmServer(t, rotatingTokenHandler)
	var persisted string
	mgr := r.Auth.NewTokenManager("rtok-seed",
		WithTokenManagerTenant("tnt-1"),
		WithRefreshSink(func(_ context.Context, newRefresh string) error {
			persisted = newRefresh
			return nil
		}),
	)
	if _, err := mgr.AccessToken(context.Background()); err != nil {
		t.Fatalf("AccessToken: %v", err)
	}
	if persisted != "rtok-user-1" {
		t.Errorf("sink persisted %q, want rtok-user-1", persisted)
	}
}

// TestTokenManager_SinkFailureBlocksThenRetrySucceeds: a sink error fails
// the acquisition (no cached access token), and the next call presents the
// rotated (live, unconsumed) token and succeeds — proving we commit the
// rotated token to memory before the sink runs.
func TestTokenManager_SinkFailureBlocksThenRetrySucceeds(t *testing.T) {
	r, tokenCalls := tmServer(t, rotatingTokenHandler)
	var failNext atomic.Bool
	failNext.Store(true)
	mgr := r.Auth.NewTokenManager("rtok-seed",
		WithTokenManagerTenant("tnt-1"),
		WithRefreshSink(func(_ context.Context, _ string) error {
			if failNext.Swap(false) {
				return fmt.Errorf("disk full")
			}
			return nil
		}),
	)
	// First acquisition: refresh succeeds server-side (rtok-user-1) but the
	// sink fails → AccessToken errors, nothing cached.
	if _, err := mgr.AccessToken(context.Background()); err == nil {
		t.Fatalf("want sink error, got nil")
	}
	if mgr.RefreshToken() != "rtok-user-1" {
		t.Errorf("expected rotated token committed pre-sink, got %q", mgr.RefreshToken())
	}
	// Retry: presents rtok-user-1, server rotates to rtok-user-2, sink ok.
	tok, err := mgr.AccessToken(context.Background())
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if tok != "atok-user-2" {
		t.Errorf("retry token: got %q", tok)
	}
	if tokenCalls.Load() != 2 {
		t.Errorf("token calls: got %d want 2", tokenCalls.Load())
	}
}

// TestTokenManager_RefreshInvalidTerminal: a refresh_invalid response is
// surfaced verbatim and not retried or fallen back on.
func TestTokenManager_RefreshInvalidTerminal(t *testing.T) {
	r, tokenCalls := tmServer(t, func(w http.ResponseWriter, _ string, _ int32) {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code": "refresh_invalid", "message": "refresh token is invalid, expired, or revoked",
		})
	})
	mgr := r.Auth.NewTokenManager("rtok-dead", WithTokenManagerTenant("tnt-1"))
	_, err := mgr.AccessToken(context.Background())
	if err == nil {
		t.Fatalf("want error, got nil")
	}
	if !IsCode(err, ErrCodeRefreshInvalid) {
		t.Errorf("want refresh_invalid, got %v", err)
	}
	if tokenCalls.Load() != 1 {
		t.Errorf("must not retry/fallback; token calls=%d want 1", tokenCalls.Load())
	}
}

// TestTokenManager_ConcurrentSingleFlight: N concurrent AccessToken calls
// on a stale cache collapse to one /auth/token request (one-time-use
// refresh must never be presented twice in parallel).
func TestTokenManager_ConcurrentSingleFlight(t *testing.T) {
	r, tokenCalls := tmServer(t, func(w http.ResponseWriter, _ string, n int32) {
		time.Sleep(40 * time.Millisecond) // widen the race window
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "ok", "subject_type": "user",
			"refresh_token": fmt.Sprintf("rtok-user-%d", n),
			"access_token":  fmt.Sprintf("atok-user-%d", n),
			"expires_in":    3600, "tenant_id": "tnt-1",
		})
	})
	mgr := r.Auth.NewTokenManager("rtok-seed", WithTokenManagerTenant("tnt-1"))

	const n = 12
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := mgr.AccessToken(context.Background()); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent AccessToken: %v", err)
	}
	if tokenCalls.Load() != 1 {
		t.Errorf("single-flight: got %d /auth/token calls want 1", tokenCalls.Load())
	}
}
