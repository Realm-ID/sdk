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

// TestTenants_CreateRoutesToPlatform verifies Create posts to the
// platform-scoped path so the platform-token caller is accepted by
// requireTenantMaintenance's service-JWT branch (SPEC §6.1).
func TestTenants_CreateRoutesToPlatform(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/platform-token", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"platform_token": "ptok", "expires_in": 300})
	})
	var hitPath string
	mux.HandleFunc("/platforms/"+testRealmID+"/tenants", func(w http.ResponseWriter, r *http.Request) {
		hitPath = r.URL.Path
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "t-new", "display_name": "Acme",
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	tnt, err := r.Tenants.Create(context.Background(), TenantCreate{
		DisplayName:    "Acme",
		AllowedDomains: []string{"acme.com"},
		SignupMode:     SignupModeAllowlist,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if tnt.ID != "t-new" || tnt.DisplayName != "Acme" {
		t.Errorf("unexpected tenant: %+v", tnt)
	}
	if hitPath == "" {
		t.Fatal("Create did not hit /platforms/{realmID}/tenants")
	}
}

// TestTenants_UpdateUserRole verifies the role-update wrapper hits
// PATCH /tenants/{id}/users/{uid}/role and decodes the response shape.
func TestTenants_UpdateUserRole(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/platform-token", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"platform_token": "ptok", "expires_in": 300})
	})
	var gotMethod, gotPath string
	var gotBody map[string]string
	mux.HandleFunc("/tenants/t1/users/u9/role", func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "u9", "role": "admin", "tenant_id": "t1", "updated_at": 1700000000,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.Tenants.UpdateUserRole(context.Background(), "t1", "u9", "admin")
	if err != nil {
		t.Fatalf("UpdateUserRole: %v", err)
	}
	if gotMethod != "PATCH" || gotPath != "/tenants/t1/users/u9/role" {
		t.Errorf("wrong wire call: %s %s", gotMethod, gotPath)
	}
	if gotBody["role"] != "admin" {
		t.Errorf("wrong body: %+v", gotBody)
	}
	if out.Role != "admin" || out.TenantID != "t1" || out.ID != "u9" {
		t.Errorf("unexpected result: %+v", out)
	}
}
