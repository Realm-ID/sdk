package realmid

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestPlatformToken_MintCacheRefresh(t *testing.T) {
	var mintCalls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/platform-token", func(w http.ResponseWriter, _ *http.Request) {
		mintCalls.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"platform_token": "ptok-fresh",
			"expires_in":     60,
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
	if tok != "ptok-fresh" {
		t.Errorf("token: got %q", tok)
	}
	if mintCalls.Load() != 1 {
		t.Errorf("mint calls: got %d", mintCalls.Load())
	}

	// Cache hit — no second mint.
	if _, err := r.platformToken.get(context.Background()); err != nil {
		t.Fatalf("cache get: %v", err)
	}
	if mintCalls.Load() != 1 {
		t.Errorf("expected cache hit, mint called %d times", mintCalls.Load())
	}

	// Force expiry to within 30s window — should refetch.
	r.platformToken.mu.Lock()
	r.platformToken.expiresAt = time.Now().Add(15 * time.Second)
	r.platformToken.mu.Unlock()
	if _, err := r.platformToken.get(context.Background()); err != nil {
		t.Fatalf("refresh get: %v", err)
	}
	if mintCalls.Load() != 2 {
		t.Errorf("expected refresh, mint called %d times", mintCalls.Load())
	}
}

func TestPlatformToken_UnauthorizedSurfaces(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/platform-token", func(w http.ResponseWriter, _ *http.Request) {
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
