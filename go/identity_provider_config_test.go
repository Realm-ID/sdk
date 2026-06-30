package realmid

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIDPConfig_ListInjectsPlatformID(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc("/identity-providers", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Errorf("method=%s", r.Method)
		}
		if pid := r.URL.Query().Get("platform_id"); pid != testRealmID {
			t.Errorf("platform_id=%q want %q", pid, testRealmID)
		}
		if tid := r.URL.Query().Get("tenant_id"); tid != "t-1" {
			t.Errorf("tenant_id=%q", tid)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []any{
				map[string]any{
					"id": "idp-1", "entity_type": "realm", "entity_id": testRealmID,
					"provider": "google", "client_type": "web", "client_id": "g-123",
					"allowed_origins": []string{"https://app.example.com"},
					"enabled":         true, "created_at": 1, "updated_at": 2,
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	page, err := r.IdentityProviderConfig.List(context.Background(), &IDPConfigListOpts{TenantID: "t-1"})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(page.Items) != 1 || page.Items[0].Provider != "google" {
		t.Errorf("items=%+v", page.Items)
	}
}

func TestIDPConfig_ListNormalizesNilItems(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc("/identity-providers", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	page, err := r.IdentityProviderConfig.List(context.Background(), nil)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if page.Items == nil || len(page.Items) != 0 {
		t.Errorf("items should normalize to empty slice, got %#v", page.Items)
	}
}

func TestIDPConfig_CreateMapsWireShape(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc("/identity-providers", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("method=%s", r.Method)
		}
		raw, _ := io.ReadAll(r.Body)
		var got map[string]any
		_ = json.Unmarshal(raw, &got)
		if got["platform_id"] != testRealmID {
			t.Errorf("platform_id not injected: %v", got)
		}
		if got["provider"] != "google" || got["client_type"] != "web" || got["client_id"] != "g-123" {
			t.Errorf("body=%v", got)
		}
		origins, ok := got["allowed_origins"].([]any)
		if !ok || len(origins) != 1 {
			t.Errorf("allowed_origins=%v", got["allowed_origins"])
		}
		w.WriteHeader(201)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "idp-1", "entity_type": "realm", "entity_id": testRealmID,
			"provider": "google", "client_type": "web", "client_id": "g-123",
			"allowed_origins": []string{"https://app.example.com"},
			"enabled":         true, "created_at": 1, "updated_at": 1,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	got, err := r.IdentityProviderConfig.Create(context.Background(), IDPConfigCreate{
		Provider: "google", ClientType: "web", ClientID: "g-123",
		AllowedOrigins: []string{"https://app.example.com"},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if got.ID != "idp-1" || !got.Enabled {
		t.Errorf("got=%+v", got)
	}
}

func TestIDPConfig_CreateConflictSurfacesErrIDPExists(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc("/identity-providers", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(409)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{"code": "conflict", "message": "exists"},
			"code":  "provider_exists",
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	_, err := r.IdentityProviderConfig.Create(context.Background(), IDPConfigCreate{
		Provider: "google", ClientType: "web", ClientID: "g-123",
		AllowedOrigins: []string{"https://app.example.com"},
	})
	if err == nil {
		t.Fatal("expected error")
	}
	if !errors.Is(err, ErrIDPExists) {
		t.Errorf("want ErrIDPExists, got %v", err)
	}
	if !IsCode(err, ErrCodeConflict) {
		t.Errorf("want underlying conflict code, got %v", err)
	}
}

func TestIDPConfig_UpdateSendsOnlyProvidedFields(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc("/identity-providers/idp-1", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "PATCH" {
			t.Errorf("method=%s", r.Method)
		}
		raw, _ := io.ReadAll(r.Body)
		var got map[string]any
		_ = json.Unmarshal(raw, &got)
		if _, has := got["client_id"]; has {
			t.Errorf("client_id should be omitted: %v", got)
		}
		if v, ok := got["enabled"].(bool); !ok || v != false {
			t.Errorf("enabled=%v", got["enabled"])
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "idp-1", "entity_type": "realm", "entity_id": testRealmID,
			"provider": "google", "client_type": "web", "client_id": "g-123",
			"enabled": false, "created_at": 1, "updated_at": 5,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	disabled := false
	got, err := r.IdentityProviderConfig.Update(context.Background(), "idp-1", IDPConfigPatch{Enabled: &disabled})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if got.Enabled {
		t.Errorf("expected disabled, got %+v", got)
	}
}

func TestIDPConfig_DeleteHappy(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc("/identity-providers/idp-1", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "DELETE" {
			t.Errorf("method=%s", r.Method)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "deleted"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.IdentityProviderConfig.Delete(context.Background(), "idp-1")
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if out.Status != "deleted" {
		t.Errorf("status=%q", out.Status)
	}
}

func TestIDPConfig_Delete404SurfacesErrIDPNotFound(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc("/identity-providers/missing", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(404)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{"code": "not_found", "message": "no such provider"},
			"code":  "provider_not_found",
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	_, err := r.IdentityProviderConfig.Delete(context.Background(), "missing")
	if err == nil {
		t.Fatal("expected error")
	}
	if !errors.Is(err, ErrIDPNotFound) {
		t.Errorf("want ErrIDPNotFound, got %v", err)
	}
}

// TestIDPConfig_CreateAndPatchSendConfig covers the provider PUBLIC config
// map (e.g. the Firebase web config) on both write paths: present-on-create
// and wholesale-replace-on-patch.
func TestIDPConfig_CreateAndPatchSendConfig(t *testing.T) {
	fb := map[string]string{
		"apiKey":     "AIza-test",
		"authDomain": "demo-app.firebaseapp.com",
		"projectId":  "demo-app",
	}

	t.Run("create includes config", func(t *testing.T) {
		mux := http.NewServeMux()
		mintPlatformToken(mux)
		mux.HandleFunc("/identity-providers", func(w http.ResponseWriter, r *http.Request) {
			raw, _ := io.ReadAll(r.Body)
			var got map[string]any
			_ = json.Unmarshal(raw, &got)
			cfg, ok := got["config"].(map[string]any)
			if !ok || cfg["apiKey"] != "AIza-test" || cfg["authDomain"] != "demo-app.firebaseapp.com" {
				t.Errorf("config not sent on create: %v", got["config"])
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "idp-1", "entity_type": "realm", "entity_id": testRealmID,
				"provider": "firebase", "client_type": "web", "client_id": "demo-app",
				"config": fb, "enabled": true, "created_at": 1, "updated_at": 1,
			})
		})
		srv := httptest.NewServer(mux)
		defer srv.Close()

		r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
		got, err := r.IdentityProviderConfig.Create(context.Background(), IDPConfigCreate{
			Provider: "firebase", ClientType: "web", ClientID: "demo-app",
			AllowedOrigins: []string{"https://app.example.com"}, Config: fb,
		})
		if err != nil {
			t.Fatalf("create: %v", err)
		}
		if got.Config["projectId"] != "demo-app" {
			t.Errorf("config not parsed back: %+v", got.Config)
		}
	})

	t.Run("patch replaces config", func(t *testing.T) {
		mux := http.NewServeMux()
		mintPlatformToken(mux)
		mux.HandleFunc("/identity-providers/idp-1", func(w http.ResponseWriter, r *http.Request) {
			raw, _ := io.ReadAll(r.Body)
			var got map[string]any
			_ = json.Unmarshal(raw, &got)
			cfg, ok := got["config"].(map[string]any)
			if !ok || cfg["apiKey"] != "AIza-test" {
				t.Errorf("config not sent on patch: %v", got["config"])
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "idp-1", "entity_type": "realm", "entity_id": testRealmID,
				"provider": "firebase", "client_type": "web", "client_id": "demo-app",
				"config": fb, "enabled": true, "created_at": 1, "updated_at": 9,
			})
		})
		srv := httptest.NewServer(mux)
		defer srv.Close()

		r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
		got, err := r.IdentityProviderConfig.Update(context.Background(), "idp-1", IDPConfigPatch{Config: &fb})
		if err != nil {
			t.Fatalf("update: %v", err)
		}
		if got.Config["authDomain"] != "demo-app.firebaseapp.com" {
			t.Errorf("config not parsed back: %+v", got.Config)
		}
	})
}
