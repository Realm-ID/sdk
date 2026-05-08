package realmid

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func adminPlatformTokenStub(mux *http.ServeMux) {
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "subject_type": "platform", "refresh_token": "rtok-platform", "access_token": "ptok", "expires_in": 300})
	})
}

func TestAdmin_ListPlatforms_QueryAndDecode(t *testing.T) {
	mux := http.NewServeMux()
	adminPlatformTokenStub(mux)
	var gotQ url.Values
	mux.HandleFunc("/admin/platforms", func(w http.ResponseWriter, r *http.Request) {
		gotQ = r.URL.Query()
		next := "n2"
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []any{
				map[string]any{
					"id":           "p1",
					"display_name": "Acme",
					"slug":         "acme",
					"status":       "active",
					"signup_mode":  "closed",
					"domains":      []string{"acme.test"},
					"owner": map[string]any{
						"user_id": "u1", "name": "Alice", "email": "a@acme.test",
					},
					"tenants_count":    3,
					"users_count":      9,
					"last_activity_at": 1700000000,
					"created_at":       1690000000,
				},
			},
			"next_cursor": next,
			"total":       42,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	hcd := true
	out, err := r.Admin.ListPlatforms(context.Background(), ListPlatformsParams{
		Q:               "ac",
		Status:          []string{"active", "suspended"},
		SignupMode:      []string{"closed"},
		Domain:          "acme.test",
		HasCustomDomain: &hcd,
		CreatedAfter:    1680000000,
		Sort:            "created_desc",
		Limit:           25,
	})
	if err != nil {
		t.Fatalf("ListPlatforms: %v", err)
	}
	if len(out.Items) != 1 || out.Items[0].ID != "p1" || out.Items[0].Owner.Email != "a@acme.test" {
		t.Errorf("unexpected items: %+v", out.Items)
	}
	if out.NextCursor == nil || *out.NextCursor != "n2" {
		t.Errorf("unexpected next_cursor: %+v", out.NextCursor)
	}
	if out.Total != 42 {
		t.Errorf("unexpected total: %d", out.Total)
	}
	if gotQ.Get("q") != "ac" || gotQ.Get("status") != "active,suspended" || gotQ.Get("has_custom_domain") != "true" {
		t.Errorf("unexpected query: %+v", gotQ)
	}
	if gotQ.Get("limit") != "25" || gotQ.Get("sort") != "created_desc" {
		t.Errorf("unexpected sort/limit: %+v", gotQ)
	}
}

func TestAdmin_Stats(t *testing.T) {
	mux := http.NewServeMux()
	adminPlatformTokenStub(mux)
	mux.HandleFunc("/admin/stats", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"platforms_count": 4, "tenants_count": 12, "users_count": 88,
			"sessions_active": 7, "events_24h": 3,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	s, err := r.Admin.Stats(context.Background())
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	if s.PlatformsCount != 4 || s.UsersCount != 88 || s.Events24h != 3 {
		t.Errorf("unexpected stats: %+v", s)
	}
}

func TestAdmin_ListEvents(t *testing.T) {
	mux := http.NewServeMux()
	adminPlatformTokenStub(mux)
	var gotQ url.Values
	mux.HandleFunc("/admin/events", func(w http.ResponseWriter, r *http.Request) {
		gotQ = r.URL.Query()
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []any{
				map[string]any{
					"id": 1, "occurred_at": 1700000000, "kind": "platform.created",
					"actor_user_id": "u1", "actor_label": "alice@acme",
					"platform_id": "p1", "summary": "alice@acme platform.created p1",
				},
			},
			"next_cursor": nil,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.Admin.ListEvents(context.Background(), ListEventsParams{
		PlatformID: "p1",
		Kind:       []string{"platform.created", "platform.suspended"},
		Since:      1690000000,
		Limit:      50,
	})
	if err != nil {
		t.Fatalf("ListEvents: %v", err)
	}
	if len(out.Items) != 1 || out.Items[0].ID != 1 || out.Items[0].Kind != "platform.created" {
		t.Errorf("unexpected events: %+v", out.Items)
	}
	if out.NextCursor != nil {
		t.Errorf("expected nil next_cursor, got %v", *out.NextCursor)
	}
	if gotQ.Get("platform_id") != "p1" || gotQ.Get("kind") != "platform.created,platform.suspended" {
		t.Errorf("unexpected query: %+v", gotQ)
	}
}

func TestAdmin_Search(t *testing.T) {
	mux := http.NewServeMux()
	adminPlatformTokenStub(mux)
	var gotQ url.Values
	mux.HandleFunc("/admin/search", func(w http.ResponseWriter, r *http.Request) {
		gotQ = r.URL.Query()
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []any{
				map[string]any{"type": "platform", "id": "p1", "label": "Acme", "sublabel": "acme"},
				map[string]any{"type": "tenant", "id": "t1", "label": "Acme Default", "platform_id": "p1"},
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.Admin.Search(context.Background(), "ac", 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(out.Items) != 2 || out.Items[0].Type != "platform" || out.Items[1].PlatformID != "p1" {
		t.Errorf("unexpected hits: %+v", out.Items)
	}
	if gotQ.Get("q") != "ac" || gotQ.Get("limit") != "10" {
		t.Errorf("unexpected query: %+v", gotQ)
	}
}

func TestAdmin_ForwardsForbidden(t *testing.T) {
	mux := http.NewServeMux()
	adminPlatformTokenStub(mux)
	mux.HandleFunc("/admin/stats", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{"code": "forbidden", "message": "base-realm staff required"},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	_, err := r.Admin.Stats(context.Background())
	if !IsCode(err, ErrCodeForbidden) {
		t.Errorf("expected forbidden, got %v", err)
	}
}
