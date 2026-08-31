package realmid

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"testing"
)

func newIntegrationsRealm(t *testing.T, url string) *Realm {
	t.Helper()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: url})
	return r
}

// TestIntegrations_Register asserts the source-side register posts to the
// platform integrations route and decodes the result.
func TestIntegrations_Register(t *testing.T) {
	var gotPath string
	var gotBody map[string]any
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/platforms/" + testRealmID + "/integrations": func(w http.ResponseWriter, r *http.Request) {
			gotPath = r.URL.Path
			buf, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(buf, &gotBody)
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "intg-1", "realm_id": testRealmID, "slug": "hiring-motion",
				"display_name": "Hiring Motion", "listed": false, "disabled": false,
			})
		},
	})
	defer srv.Close()

	out, err := newIntegrationsRealm(t, srv.URL).Integrations.Register(context.Background(),
		IntegrationCreate{Slug: "hiring-motion", DisplayName: "Hiring Motion"})
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if gotPath != "/platforms/"+testRealmID+"/integrations" {
		t.Errorf("path = %q", gotPath)
	}
	if gotBody["slug"] != "hiring-motion" {
		t.Errorf("body slug = %v", gotBody["slug"])
	}
	if out.ID != "intg-1" || out.Slug != "hiring-motion" {
		t.Errorf("decoded = %+v", out)
	}
}

// TestIntegrations_SlugTakenMapsSentinel: 409 slug_taken → ErrIntegrationSlugTaken.
func TestIntegrations_SlugTakenMapsSentinel(t *testing.T) {
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/platforms/" + testRealmID + "/integrations": func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "taken", "code": "slug_taken"})
		},
	})
	defer srv.Close()
	_, err := newIntegrationsRealm(t, srv.URL).Integrations.Register(context.Background(),
		IntegrationCreate{Slug: "dup", DisplayName: "Dup"})
	if !errors.Is(err, ErrIntegrationSlugTaken) {
		t.Errorf("want ErrIntegrationSlugTaken, got %v", err)
	}
}

// TestIntegrations_Install asserts the target-side install posts to the tenant
// installations route with the STATED PERMISSION LIST (ADR-101 D7).
//
// This test previously asserted the body carried `role_id`, which is why the
// SDK shipped broken against the live issuer for as long as it did: the issuer
// replaced role_id with `permissions` and answers `400 permissions_required`,
// while the test pinned the old shape and stayed green. A test that asserts
// the implementation protects the bug.
func TestIntegrations_Install(t *testing.T) {
	var gotBody map[string]any
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/tenants/t1/integration-installations": func(w http.ResponseWriter, r *http.Request) {
			buf, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(buf, &gotBody)
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "inst-1", "integration_id": "intg-1",
				"permissions":       []string{"users:read"},
				"principal_user_id": "u-9", "status": "installed",
			})
		},
	})
	defer srv.Close()
	out, err := newIntegrationsRealm(t, srv.URL).Integrations.Install(context.Background(), "t1",
		InstallRequest{IntegrationID: "intg-1", Permissions: []string{"users:read"}})
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	if gotBody["integration_id"] != "intg-1" {
		t.Errorf("integration_id: body = %v", gotBody)
	}
	// The wire field must be `permissions`, and `role_id` must be ABSENT —
	// asserting only the former would still pass if both were sent.
	perms, ok := gotBody["permissions"].([]any)
	if !ok || len(perms) != 1 || perms[0] != "users:read" {
		t.Errorf("permissions: body = %v", gotBody)
	}
	if _, present := gotBody["role_id"]; present {
		t.Errorf("role_id must not be sent — the issuer retired it (ADR-101 D7): %v", gotBody)
	}
	if out.ID != "inst-1" || out.Status != "installed" {
		t.Errorf("decoded = %+v", out)
	}
	if len(out.Permissions) != 1 || out.Permissions[0] != "users:read" {
		t.Errorf("decoded permissions = %+v", out.Permissions)
	}
}

// TestIntegrations_PermissionErrorsMapSentinels covers the three refusals the
// permission-stated install can produce. None of them existed while the SDK
// was still sending role_id, so none had a sentinel.
func TestIntegrations_PermissionErrorsMapSentinels(t *testing.T) {
	for _, tc := range []struct {
		code   string
		status int
		want   error
	}{
		{"permissions_required", http.StatusBadRequest, ErrPermissionsRequired},
		{"unknown_permission", http.StatusBadRequest, ErrUnknownPermission},
		{"permissions_exceed_grantor", http.StatusForbidden, ErrPermissionsExceedGrantor},
	} {
		t.Run(tc.code, func(t *testing.T) {
			srv := authTestServer(t, map[string]http.HandlerFunc{
				"/tenants/t1/integration-installations": func(w http.ResponseWriter, r *http.Request) {
					w.WriteHeader(tc.status)
					_ = json.NewEncoder(w).Encode(map[string]any{
						"error": map[string]any{"code": tc.code, "message": tc.code},
					})
				},
			})
			defer srv.Close()
			_, err := newIntegrationsRealm(t, srv.URL).Integrations.Install(context.Background(), "t1",
				InstallRequest{IntegrationID: "intg-1", Permissions: []string{"users:read"}})
			if !errors.Is(err, tc.want) {
				t.Fatalf("want %v, got %v", tc.want, err)
			}
		})
	}
}

// TestIntegrations_RoleNotServiceTypedMapsSentinel: 400 role_not_service_typed
// → ErrRoleNotServiceTyped. RETAINED FOR THE MAPPING ONLY: the issuer has not
// emitted this code since ADR-101 D7, so this asserts the sentinel still
// resolves for anyone matching it, NOT that the refusal can still occur.
func TestIntegrations_RoleNotServiceTypedMapsSentinel(t *testing.T) {
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/tenants/t1/integration-installations": func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "no", "code": "role_not_service_typed"})
		},
	})
	defer srv.Close()
	_, err := newIntegrationsRealm(t, srv.URL).Integrations.Install(context.Background(), "t1",
		InstallRequest{IntegrationID: "intg-1", Permissions: []string{"users:read"}})
	if !errors.Is(err, ErrRoleNotServiceTyped) {
		t.Errorf("want ErrRoleNotServiceTyped, got %v", err)
	}
}

// TestIntegrations_ListInstallations decodes the inbound-access page.
func TestIntegrations_ListInstallations(t *testing.T) {
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/tenants/t1/integration-installations": func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items": []any{
					map[string]any{"id": "inst-1", "integration_id": "intg-1",
						"permissions": []string{"users:read", "users:manage"}, "mint_count": 3},
				},
				"next_cursor": nil,
			})
		},
	})
	defer srv.Close()
	page, err := newIntegrationsRealm(t, srv.URL).Integrations.ListInstallations(context.Background(), "t1", nil)
	if err != nil {
		t.Fatalf("ListInstallations: %v", err)
	}
	if len(page.Items) != 1 || page.Items[0].MintCount != 3 ||
		len(page.Items[0].Permissions) != 2 || page.Items[0].Permissions[0] != "users:read" {
		t.Errorf("decoded = %+v", page.Items)
	}
}

// TestIntegrations_Uninstall asserts DELETE on the installation route.
func TestIntegrations_Uninstall(t *testing.T) {
	var gotMethod, gotPath string
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/tenants/t1/integration-installations/inst-1": func(w http.ResponseWriter, r *http.Request) {
			gotMethod, gotPath = r.Method, r.URL.Path
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
		},
	})
	defer srv.Close()
	if err := newIntegrationsRealm(t, srv.URL).Integrations.Uninstall(context.Background(), "t1", "inst-1"); err != nil {
		t.Fatalf("Uninstall: %v", err)
	}
	if gotMethod != "DELETE" || gotPath != "/tenants/t1/integration-installations/inst-1" {
		t.Errorf("method/path = %s %s", gotMethod, gotPath)
	}
}

// TestIntegrations_MintToken asserts the mint posts the integration_installation
// grant with the raw api key (NO Authorization header) and decodes the token.
func TestIntegrations_MintToken(t *testing.T) {
	var gotAuth string
	var gotBody map[string]any
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/login": func(w http.ResponseWriter, r *http.Request) {
			gotAuth = r.Header.Get("Authorization")
			buf, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(buf, &gotBody)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status": "ok", "subject_type": "service",
				"access_token": "brokered-jwt", "expires_in": 600,
				"tenant_id": "t-target", "role": "svc",
			})
		},
	})
	defer srv.Close()
	out, err := newIntegrationsRealm(t, srv.URL).Integrations.MintToken(context.Background(),
		IntegrationMintRequest{APIKey: "rk_live_src", InstallationID: "inst-1", SourceOrgID: "org-a"})
	if err != nil {
		t.Fatalf("MintToken: %v", err)
	}
	if gotBody["grant_type"] != "integration_installation" {
		t.Errorf("grant_type = %v", gotBody["grant_type"])
	}
	if gotBody["api_key"] != "rk_live_src" || gotBody["source_org_id"] != "org-a" {
		t.Errorf("body = %v", gotBody)
	}
	// The raw key is the credential — it must NOT ride as a bearer.
	if gotAuth != "" {
		t.Errorf("mint must not send Authorization; got %q", gotAuth)
	}
	if out.AccessToken != "brokered-jwt" || out.ExpiresIn != 600 || out.Role != "svc" {
		t.Errorf("decoded = %+v", out)
	}
}

// TestIntegrations_MintKeyClassMismatchMapsSentinel: 401 key_class_mismatch →
// ErrKeyClassMismatch.
func TestIntegrations_MintKeyClassMismatchMapsSentinel(t *testing.T) {
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/login": func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "no", "code": "key_class_mismatch"})
		},
	})
	defer srv.Close()
	_, err := newIntegrationsRealm(t, srv.URL).Integrations.MintToken(context.Background(),
		IntegrationMintRequest{APIKey: "rk_live_svc", InstallationID: "inst-1", SourceOrgID: "org-a"})
	if !errors.Is(err, ErrKeyClassMismatch) {
		t.Errorf("want ErrKeyClassMismatch, got %v", err)
	}
}

// TestIntegrations_DisableEnableRemove exercises the source lifecycle verbs.
func TestIntegrations_DisableEnableRemove(t *testing.T) {
	hits := map[string]string{}
	h := func(w http.ResponseWriter, r *http.Request) {
		hits[r.URL.Path] = r.Method
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
	}
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/platforms/" + testRealmID + "/integrations/intg-1/disable": h,
		"/platforms/" + testRealmID + "/integrations/intg-1/enable":  h,
		"/platforms/" + testRealmID + "/integrations/intg-1":         h,
	})
	defer srv.Close()
	c := newIntegrationsRealm(t, srv.URL).Integrations
	if err := c.Disable(context.Background(), "intg-1"); err != nil {
		t.Fatalf("Disable: %v", err)
	}
	if err := c.Enable(context.Background(), "intg-1"); err != nil {
		t.Fatalf("Enable: %v", err)
	}
	if err := c.Remove(context.Background(), "intg-1"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if hits["/platforms/"+testRealmID+"/integrations/intg-1/disable"] != "POST" ||
		hits["/platforms/"+testRealmID+"/integrations/intg-1/enable"] != "POST" ||
		hits["/platforms/"+testRealmID+"/integrations/intg-1"] != "DELETE" {
		t.Errorf("hits = %v", hits)
	}
}
