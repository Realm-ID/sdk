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
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "subject_type": "platform", "refresh_token": "rtok-platform", "access_token": "ptok", "expires_in": 300})
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
	mux.HandleFunc("/platforms/"+testRealmID+"/roles", func(w http.ResponseWriter, r *http.Request) {
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
					"id": "role-owner", "name": "owner", "permissions": []string{},
					"is_system": true, "created_at": 1, "updated_at": 1,
				},
				map[string]any{
					"id": "role-salesman", "name": "salesman", "display_name": "Field Sales",
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
	mux.HandleFunc("/platforms/"+testRealmID+"/roles", func(w http.ResponseWriter, r *http.Request) {
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
			"id":   "role-salesman",
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

func TestRoles_CreateForwardsRequiredMFA(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc("/platforms/"+testRealmID+"/roles", func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var got map[string]any
		_ = json.Unmarshal(raw, &got)
		mfa, ok := got["required_mfa_methods"].([]any)
		if !ok || len(mfa) != 1 || mfa[0] != "otp" {
			t.Errorf("required_mfa_methods=%v", got["required_mfa_methods"])
		}
		w.WriteHeader(201)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "role-cashier", "name": "cashier", "display_name": "Cashier",
			"permissions": []string{}, "required_mfa_methods": []string{"otp"},
			"is_system": false, "created_at": 1, "updated_at": 1,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	got, err := r.Roles.Create(context.Background(), RoleCreate{
		Name: "cashier", DisplayName: "Cashier", RequiredMFAMethods: []string{"otp"},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if len(got.RequiredMFAMethods) != 1 || got.RequiredMFAMethods[0] != "otp" {
		t.Errorf("decoded required_mfa_methods=%v", got.RequiredMFAMethods)
	}
}

func TestRoles_UpdateSendsOnlyProvidedFields(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc("/platforms/"+testRealmID+"/roles/role-salesman", func(w http.ResponseWriter, r *http.Request) {
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
			"id":          "role-salesman",
			"name":        "salesman",
			"permissions": []string{"bills:read", "orders:all"},
			"is_system":   false, "created_at": 1, "updated_at": 2,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	perms := []string{"bills:read", "orders:all"}
	got, err := r.Roles.Update(context.Background(), "role-salesman", RolePatch{Permissions: &perms})
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
	mux.HandleFunc("/platforms/"+testRealmID+"/roles/role-old", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "DELETE" {
			t.Errorf("method=%s", r.Method)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "deleted"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.Roles.Delete(context.Background(), "role-old")
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
	mux.HandleFunc("/platforms/"+testRealmID+"/roles/role-salesman", func(w http.ResponseWriter, _ *http.Request) {
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
	_, err := r.Roles.Delete(context.Background(), "role-salesman")
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
	mux.HandleFunc("/platforms/"+testRealmID+"/roles/role-oldname/rename", func(w http.ResponseWriter, r *http.Request) {
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
			"id":   "role-oldname",
			"name": "newname", "permissions": []string{},
			"is_system": false, "created_at": 1, "updated_at": 2,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	got, err := r.Roles.Rename(context.Background(), "role-oldname", "newname")
	if err != nil {
		t.Fatalf("rename: %v", err)
	}
	if got.Name != "newname" {
		t.Errorf("name=%q", got.Name)
	}
}

func TestRoles_ListForwardsIncludeSystem(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc("/platforms/"+testRealmID+"/roles", func(w http.ResponseWriter, r *http.Request) {
		if v := r.URL.Query().Get("include_system"); v != "true" {
			t.Errorf("include_system=%q", v)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{}, "next_cursor": nil})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	if _, err := r.Roles.List(context.Background(), &RoleListOpts{IncludeSystem: true}); err != nil {
		t.Fatalf("list: %v", err)
	}
}

func TestRoles_DisablePostsAndDecodesDisabledFields(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc("/platforms/"+testRealmID+"/roles/role-x/disable", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("method=%s", r.Method)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "role-x", "name": "salesman", "permissions": []string{},
			"is_system": false, "disabled": true, "disabled_at": 42,
			"created_at": 1, "updated_at": 2,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	got, err := r.Roles.Disable(context.Background(), "role-x")
	if err != nil {
		t.Fatalf("disable: %v", err)
	}
	if !got.Disabled {
		t.Errorf("want Disabled=true")
	}
	if got.DisabledAt != 42 {
		t.Errorf("DisabledAt=%d, want 42", got.DisabledAt)
	}
}

func TestRoles_EnablePosts(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc("/platforms/"+testRealmID+"/roles/role-x/enable", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("method=%s", r.Method)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "role-x", "name": "salesman", "permissions": []string{},
			"is_system": false, "disabled": false, "created_at": 1, "updated_at": 3,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	got, err := r.Roles.Enable(context.Background(), "role-x")
	if err != nil {
		t.Fatalf("enable: %v", err)
	}
	if got.Disabled {
		t.Errorf("want Disabled=false")
	}
}
