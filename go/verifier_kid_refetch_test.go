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

// jwksCounter serves one fixed key set and counts the fetches.
func jwksCounter(t *testing.T, keys []jwk) (*httptest.Server, *int32) {
	t.Helper()
	var n int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/"+testRealmID+"/.well-known/jwks.json" {
			http.NotFound(w, r)
			return
		}
		atomic.AddInt32(&n, 1)
		time.Sleep(20 * time.Millisecond)
		_ = json.NewEncoder(w).Encode(jwksDoc{Keys: keys})
	}))
	t.Cleanup(srv.Close)
	return srv, &n
}

func TestVerify_UnknownKidRefetchesAtMostOncePer5s(t *testing.T) {
	signKnown, knownJwk := mintKey(t, "kid-known")
	signOther, _ := mintKey(t, "kid-other")
	srv, n := jwksCounter(t, []jwk{knownJwk})

	clock := time.Now()
	var mu sync.Mutex
	r, err := NewRealm(Config{
		SessionStore: NewMemorySessionStore(),
		RealmID:      testRealmID,
		APIKey:       "rk_live_test",
		BaseURL:      srv.URL,
		Clock: func() time.Time {
			mu.Lock()
			defer mu.Unlock()
			return clock
		},
	})
	if err != nil {
		t.Fatalf("NewRealm: %v", err)
	}
	claims := func() map[string]any {
		mu.Lock()
		defer mu.Unlock()
		return map[string]any{
			"iss": srv.URL + "/" + testRealmID, "sub": "u1", "aud": testAud,
			"iat": clock.Unix(), "exp": clock.Unix() + 600,
		}
	}
	ctx := context.Background()
	opt := &VerifyOptions{Audience: testAud}

	if _, err := r.Verify(ctx, signKnown(claims()), opt); err != nil {
		t.Fatalf("known kid: %v", err)
	}
	if got := atomic.LoadInt32(n); got != 1 {
		t.Fatalf("after first verify: %d fetches, want 1", got)
	}

	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = r.Verify(ctx, signOther(claims()), opt)
		}()
	}
	wg.Wait()
	if got := atomic.LoadInt32(n); got != 1 {
		t.Fatalf("unknown kid inside the 5s window: %d fetches, want 1", got)
	}

	mu.Lock()
	clock = clock.Add(5 * time.Second)
	mu.Unlock()
	var wg2 sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg2.Add(1)
		go func() {
			defer wg2.Done()
			_, _ = r.Verify(ctx, signOther(claims()), opt)
		}()
	}
	wg2.Wait()
	if got := atomic.LoadInt32(n); got != 2 {
		t.Fatalf("after the window, concurrent unknown kids: %d fetches, want 2 (single flight)", got)
	}
}

func TestVerify_FailedRefetchForAnUnknownKidStartsTheWindow(t *testing.T) {
	signOther, _ := mintKey(t, "kid-other")
	signKnown, knownJwk := mintKey(t, "kid-known")
	var n int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(20 * time.Millisecond)
		if atomic.AddInt32(&n, 1) == 1 {
			_ = json.NewEncoder(w).Encode(jwksDoc{Keys: []jwk{knownJwk}})
			return
		}
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()

	clock := time.Now()
	var mu sync.Mutex
	r, err := NewRealm(Config{
		SessionStore: NewMemorySessionStore(),
		RealmID:      testRealmID,
		APIKey:       "rk_live_test",
		BaseURL:      srv.URL,
		Clock: func() time.Time {
			mu.Lock()
			defer mu.Unlock()
			return clock
		},
	})
	if err != nil {
		t.Fatalf("NewRealm: %v", err)
	}
	claims := func() map[string]any {
		mu.Lock()
		defer mu.Unlock()
		return map[string]any{
			"iss": srv.URL + "/" + testRealmID, "sub": "u1", "aud": testAud,
			"iat": clock.Unix(), "exp": clock.Unix() + 600,
		}
	}
	opt := &VerifyOptions{Audience: testAud}
	run := func() {
		var wg sync.WaitGroup
		for i := 0; i < 10; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, err := r.Verify(context.Background(), signOther(claims()), opt)
				if err == nil {
					t.Errorf("verify succeeded against a failing JWKS")
				}
			}()
		}
		wg.Wait()
	}
	if _, err := r.Verify(context.Background(), signKnown(claims()), opt); err != nil {
		t.Fatalf("known kid: %v", err)
	}
	mu.Lock()
	clock = clock.Add(5 * time.Second) // the priming fetch started its own window
	mu.Unlock()
	run()
	if got := atomic.LoadInt32(&n); got != 2 {
		t.Fatalf("10 unknown-kid verifies against a failing JWKS: %d fetches, want 2 (one priming, one refetch)", got)
	}
	run()
	if got := atomic.LoadInt32(&n); got != 2 {
		t.Fatalf("inside the window: %d fetches, want 2", got)
	}
	mu.Lock()
	clock = clock.Add(5 * time.Second)
	mu.Unlock()
	run()
	if got := atomic.LoadInt32(&n); got != 3 {
		t.Fatalf("after the window: %d fetches, want 3", got)
	}
}
