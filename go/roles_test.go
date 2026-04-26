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

func mintPlatformToken(mux *http.ServeMux) {
	mux.HandleFunc("/auth/platform-token", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"platform_token": "ptok", "expires_in": 300})
	})
}

func TestRoles_SystemConstants(t *testing.T) {
	if RoleOwner != "owner" {
		t.Errorf("RoleOwner = %q, want owner", RoleOwner)
	}
	if RoleMember != "member" {
		t.Errorf("RoleMember = %q, want member", RoleMember)
	}
}

func TestRoles_ListReturnsLockedEnvelope(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc("/realms/"+testRealmID+"/roles", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Errorf("method=%s", r.Method)
		}
		if c := r.URL.Query().Get("cursor"); c != "c1" {
			t.Errorf("cursor=%q", c)
		}
		if l := r.URL.Query().Get("limit"); l != "25" {
			t.Errorf("limit=%q", l)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []any{
				map[string]any{
					"name": "owner", "permissions": []string{},
					"is_system": true, "created_at": 1, "updated_at": 1,
				},
				map[string]any{
					"name": "salesman", "display_name": "Field Sales",
					"permissions": []string{"bills:read"},
					"is_system":   false, "created_at": 2, "updated_at": 3,
				},
			},
			"next_cursor": nil,
			"total":       2,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	page, err := r.Roles.List(context.Background(), &RoleListOpts{Cursor: "c1", Limit: 25})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(page.Items) != 2 {
		t.Fatalf("len=%d", len(page.Items))
	}
	if page.Items[1].Name != "salesman" {
		t.Errorf("name=%q", page.Items[1].Name)
	}
	if page.Items[1].DisplayName != "Field Sales" {
		t.Errorf("display=%q", page.Items[1].DisplayName)
	}
	if page.NextCursor != "" {
		t.Errorf("nextCursor=%q", page.NextCursor)
	}
	if page.Total == nil || *page.Total != 2 {
		t.Errorf("total=%v", page.Total)
	}
}

func TestRoles_CreateMapsWireShape(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc("/realms/"+testRealmID+"/roles", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("method=%s", r.Method)
		}
		raw, _ := io.ReadAll(r.Body)
		var got map[string]any
		_ = json.Unmarshal(raw, &got)
		if got["name"] != "salesman" || got["display_name"] != "Field Sales" {
			t.Errorf("body=%v", got)
		}
		w.WriteHeader(201)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"name": "salesman", "display_name": "Field Sales",
			"permissions": []string{"bills:read"},
			"is_system":   false, "created_at": 1, "updated_at": 1,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	got, err := r.Roles.Create(context.Background(), RoleCreate{
		Name: "salesman", DisplayName: "Field Sales", Permissions: []string{"bills:read"},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if got.Name != "salesman" || got.IsSystem {
		t.Errorf("got=%+v", got)
	}
}

func TestRoles_UpdateSendsOnlyProvidedFields(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc("/realms/"+testRealmID+"/roles/salesman", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "PATCH" {
			t.Errorf("method=%s", r.Method)
		}
		raw, _ := io.ReadAll(r.Body)
		var got map[string]any
		_ = json.Unmarshal(raw, &got)
		if _, hasDisplay := got["display_name"]; hasDisplay {
			t.Errorf("display_name should be omitted: %v", got)
		}
		perms, ok := got["permissions"].([]any)
		if !ok || len(perms) != 2 {
			t.Errorf("permissions=%v", got["permissions"])
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"name": "salesman",
			"permissions": []string{"bills:read", "orders:all"},
			"is_system":   false, "created_at": 1, "updated_at": 2,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	perms := []string{"bills:read", "orders:all"}
	got, err := r.Roles.Update(context.Background(), "salesman", RolePatch{Permissions: &perms})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if len(got.Permissions) != 2 {
		t.Errorf("permissions=%v", got.Permissions)
	}
}

func TestRoles_DeleteHappy(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc("/realms/"+testRealmID+"/roles/old", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "DELETE" {
			t.Errorf("method=%s", r.Method)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "deleted"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.Roles.Delete(context.Background(), "old")
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if out.Status != "deleted" {
		t.Errorf("status=%q", out.Status)
	}
}

func TestRoles_Delete409SurfacesErrRoleInUse(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc("/realms/"+testRealmID+"/roles/salesman", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(409)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error":       map[string]any{"code": "conflict", "message": "role still attached to users"},
			"code":        "role_in_use",
			"role_in_use": true,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	_, err := r.Roles.Delete(context.Background(), "salesman")
	if err == nil {
		t.Fatalf("expected error")
	}
	if !errors.Is(err, ErrRoleInUse) {
		t.Errorf("want ErrRoleInUse, got %v", err)
	}
	if !IsCode(err, ErrCodeConflict) {
		t.Errorf("want underlying conflict code, got %v", err)
	}
}

func TestRoles_RenamePostsTo(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc("/realms/"+testRealmID+"/roles/oldname/rename", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("method=%s", r.Method)
		}
		raw, _ := io.ReadAll(r.Body)
		var got map[string]any
		_ = json.Unmarshal(raw, &got)
		if got["to"] != "newname" {
			t.Errorf("body=%v", got)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"name": "newname", "permissions": []string{},
			"is_system": false, "created_at": 1, "updated_at": 2,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	got, err := r.Roles.Rename(context.Background(), "oldname", "newname")
	if err != nil {
		t.Fatalf("rename: %v", err)
	}
	if got.Name != "newname" {
		t.Errorf("name=%q", got.Name)
	}
}
