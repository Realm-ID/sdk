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

func TestNormalizeOrigin(t *testing.T) {
	cases := []struct{ in, want string }{
		{"https://App.Example.com:8443/foo", "app.example.com"},
		{"http://localhost:5173", "localhost"},
		{"ACME.com", "acme.com"},
		{"", ""},
		{"  https://Foo.Bar  ", "foo.bar"},
	}
	for _, c := range cases {
		if got := NormalizeOrigin(c.in); got != c.want {
			t.Errorf("NormalizeOrigin(%q) = %q want %q", c.in, got, c.want)
		}
	}
}

func originsServer(t *testing.T, mintCount, listCount *int32, listHandler http.HandlerFunc) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mintHandler := func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(mintCount, 1)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "ok", "subject_type": "platform",
			"refresh_token": "rtok-platform", "access_token": "ptok", "expires_in": 300,
		})
	}
	// /auth/login (initial mint) and /auth/token (refresh) share the
	// same mock; both bump mintCount so existing assertions hold.
	mux.HandleFunc("/auth/login", mintHandler)
	mux.HandleFunc("/auth/token", mintHandler)
	mux.HandleFunc("/platforms/"+testRealmID+"/origins", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(listCount, 1)
		listHandler(w, r)
	})
	return httptest.NewServer(mux)
}

func TestOrigins_ValidateCachesAcrossCalls(t *testing.T) {
	var mintCount, listCount int32
	srv := originsServer(t, &mintCount, &listCount, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []any{
				map[string]any{"id": "o1", "domain": "app.acme.com", "entity_type": "tenant", "entity_id": "t1"},
				map[string]any{"id": "o2", "domain": "auth.acme.com", "entity_type": "realm", "entity_id": testRealmID},
			},
			"next_cursor": nil,
		})
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	ctx := context.Background()
	ok, err := r.Origins.Validate(ctx, ValidateOriginOptions{RealmID: testRealmID, Origin: "https://app.acme.com"})
	if err != nil || !ok {
		t.Fatalf("first validate: ok=%v err=%v", ok, err)
	}
	ok, err = r.Origins.Validate(ctx, ValidateOriginOptions{RealmID: testRealmID, Origin: "https://AUTH.acme.com:443"})
	if err != nil || !ok {
		t.Fatalf("second validate: ok=%v err=%v", ok, err)
	}
	miss, err := r.Origins.Validate(ctx, ValidateOriginOptions{RealmID: testRealmID, Origin: "https://other.com"})
	if err != nil || miss {
		t.Fatalf("miss: ok=%v err=%v", miss, err)
	}
	if got := atomic.LoadInt32(&listCount); got != 1 {
		t.Errorf("list calls = %d, want 1 (cache should serve subsequent validates)", got)
	}
}

func TestOrigins_TTLExpiry(t *testing.T) {
	var mintCount, listCount int32
	srv := originsServer(t, &mintCount, &listCount, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []any{
				map[string]any{"id": "o1", "domain": "app.acme.com", "entity_type": "tenant", "entity_id": "t1"},
			},
			"next_cursor": nil,
		})
	})
	defer srv.Close()

	now := time.Unix(1_000_000, 0)
	clock := func() time.Time { return now }
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL, Clock: clock})
	ctx := context.Background()

	if ok, _ := r.Origins.Validate(ctx, ValidateOriginOptions{RealmID: testRealmID, Origin: "https://app.acme.com"}); !ok {
		t.Fatal("first validate failed")
	}
	now = now.Add(4 * time.Minute) // still within TTL
	if ok, _ := r.Origins.Validate(ctx, ValidateOriginOptions{RealmID: testRealmID, Origin: "https://app.acme.com"}); !ok {
		t.Fatal("4min validate failed")
	}
	if got := atomic.LoadInt32(&listCount); got != 1 {
		t.Errorf("list calls before TTL expiry = %d, want 1", got)
	}
	now = now.Add(2 * time.Minute) // past 5min TTL
	if ok, _ := r.Origins.Validate(ctx, ValidateOriginOptions{RealmID: testRealmID, Origin: "https://app.acme.com"}); !ok {
		t.Fatal("post-TTL validate failed")
	}
	if got := atomic.LoadInt32(&listCount); got != 2 {
		t.Errorf("list calls after TTL expiry = %d, want 2", got)
	}
}

func TestOrigins_RefreshOn401(t *testing.T) {
	var mintCount, listCount int32
	var failed atomic.Bool
	srv := originsServer(t, &mintCount, &listCount, func(w http.ResponseWriter, _ *http.Request) {
		if failed.CompareAndSwap(false, true) {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": map[string]any{"code": "unauthorized", "message": "stale"},
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []any{
				map[string]any{"id": "o1", "domain": "app.acme.com", "entity_type": "tenant", "entity_id": "t1"},
			},
			"next_cursor": nil,
		})
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	ok, err := r.Origins.Validate(context.Background(), ValidateOriginOptions{
		RealmID: testRealmID, Origin: "https://app.acme.com",
	})
	if err != nil || !ok {
		t.Fatalf("retry validate: ok=%v err=%v", ok, err)
	}
	if got := atomic.LoadInt32(&mintCount); got != 2 {
		t.Errorf("mint count = %d, want 2 (initial + post-401 refresh)", got)
	}
}

func TestOrigins_PersistentUnauthorized(t *testing.T) {
	var mintCount, listCount int32
	srv := originsServer(t, &mintCount, &listCount, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{"code": "unauthorized", "message": "nope"},
		})
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	_, err := r.Origins.Validate(context.Background(), ValidateOriginOptions{
		RealmID: testRealmID, Origin: "https://app.acme.com",
	})
	if !IsCode(err, ErrCodeUnauthorized) {
		t.Fatalf("want ErrCodeUnauthorized, got %v", err)
	}
}

func TestOrigins_ListPaginates(t *testing.T) {
	var mintCount, listCount int32
	srv := originsServer(t, &mintCount, &listCount, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("cursor") == "c1" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items":       []any{map[string]any{"id": "o2", "domain": "b.com", "entity_type": "tenant", "entity_id": "t1"}},
				"next_cursor": nil,
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items":       []any{map[string]any{"id": "o1", "domain": "a.com", "entity_type": "realm", "entity_id": testRealmID}},
			"next_cursor": "c1",
		})
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	pg, err := r.Origins.List(context.Background(), ListOriginsOptions{RealmID: testRealmID})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	var got []string
	for o, err := range pg.All(context.Background()) {
		if err != nil {
			t.Fatalf("iter: %v", err)
		}
		got = append(got, o.Domain)
	}
	want := []string{"a.com", "b.com"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("got %v want %v", got, want)
	}
}

// TestOrigins_DecodesNumericCreatedAt is the regression guard for the
// go/v0.21.0 outage: the issuer serializes created_at as a unix-seconds JSON
// *number* (toDomainDTO → CreatedAt.Unix()), but Origin.CreatedAt was typed
// string, so the strict decode of the allowlist threw before login could run
// ("cannot unmarshal number into Go struct field Origin.items.created_at of
// type string") — taking the whole BFF /auth/* surface down. The payload here
// mirrors a real GET /platforms/{id}/origins row, including created_at and a
// detached_at, which no prior test exercised.
func TestOrigins_DecodesNumericCreatedAt(t *testing.T) {
	var mintCount, listCount int32
	srv := originsServer(t, &mintCount, &listCount, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []any{
				map[string]any{
					"id": "o1", "domain": "app.acme.com",
					"entity_type": "realm", "entity_id": testRealmID,
					"verification_id": "v-123",
					"created_at":      1_751_241_600, // unix seconds, a JSON number
				},
			},
			"next_cursor": nil,
		})
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})

	// Validate is the login hot path: it must not error on a populated row.
	ok, err := r.Origins.Validate(context.Background(), ValidateOriginOptions{
		RealmID: testRealmID, Origin: "https://app.acme.com",
	})
	if err != nil {
		t.Fatalf("validate errored on numeric created_at (the outage): %v", err)
	}
	if !ok {
		t.Fatal("validate should allow the listed origin")
	}

	// And the value round-trips as unix seconds.
	pg, err := r.Origins.List(context.Background(), ListOriginsOptions{RealmID: testRealmID})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	for o, err := range pg.All(context.Background()) {
		if err != nil {
			t.Fatalf("iter: %v", err)
		}
		if o.CreatedAt != 1_751_241_600 {
			t.Errorf("CreatedAt = %d, want 1751241600 (unix seconds)", o.CreatedAt)
		}
	}
}

func TestOrigins_ValidateRequiresRealmID(t *testing.T) {
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: "http://localhost:0"})
	_, err := r.Origins.Validate(context.Background(), ValidateOriginOptions{Origin: "https://x"})
	if !IsCode(err, ErrCodeBadRequest) {
		t.Errorf("want bad_request, got %v", err)
	}
}
