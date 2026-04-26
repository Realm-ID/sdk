package realmid

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTenants_ListPaginatesAcrossPages(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/platform-token", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"platform_token": "ptok", "expires_in": 300})
	})
	calls := 0
	mux.HandleFunc("/tenants", func(w http.ResponseWriter, r *http.Request) {
		calls++
		cursor := r.URL.Query().Get("cursor")
		switch cursor {
		case "":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items": []any{
					map[string]any{"id": "t1", "display_name": "One"},
					map[string]any{"id": "t2", "display_name": "Two"},
				},
				"next_cursor": "page2",
			})
		case "page2":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items": []any{
					map[string]any{"id": "t3", "display_name": "Three"},
				},
				"next_cursor": "",
			})
		default:
			http.Error(w, "bad cursor", 400)
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	var ids []string
	for tn, err := range r.Tenants.List(context.Background()).All(context.Background()) {
		if err != nil {
			t.Fatalf("iter: %v", err)
		}
		ids = append(ids, tn.ID)
	}
	if len(ids) != 3 || ids[0] != "t1" || ids[2] != "t3" {
		t.Errorf("ids: %v", ids)
	}
	if calls != 2 {
		t.Errorf("expected 2 page fetches, got %d", calls)
	}
}

func TestTenants_RejectsBadShape(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/platform-token", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"platform_token": "ptok", "expires_in": 300})
	})
	mux.HandleFunc("/tenants", func(w http.ResponseWriter, _ *http.Request) {
		// flat array — not the locked shape
		_ = json.NewEncoder(w).Encode([]any{
			map[string]any{"id": "t1"},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	_, err := r.Tenants.List(context.Background()).Page(context.Background(), nil)
	if !IsCode(err, ErrCodeServerError) {
		t.Errorf("expected server_error, got %v", err)
	}
}
