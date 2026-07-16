package realmid

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFederationBindings_CRUD(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "subject_type": "platform", "refresh_token": "rtok-platform", "access_token": "ptok", "expires_in": 300})
	})
	base := "/platforms/" + testRealmID + "/federation-bindings"
	var createBody map[string]any
	var listMethod, createMethod, delMethod, delPath string
	mux.HandleFunc(base, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case "GET":
			listMethod = r.Method
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items": []any{
					map[string]any{"id": "fb1", "issuer": "https://token.actions.githubusercontent.com", "status": "active", "match_claims": map[string]any{"repository": "acme/billing"}},
				},
				"next_cursor": "",
			})
		case "POST":
			createMethod = r.Method
			_ = json.NewDecoder(r.Body).Decode(&createBody)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "fb2", "platform_id": testRealmID, "issuer": createBody["issuer"],
				"audience": "ri-const", "status": "active", "mapped_role": "platform_api",
				"match_claims": createBody["match_claims"], "scope": []any{"read"},
			})
		}
	})
	mux.HandleFunc(base+"/fb2", func(w http.ResponseWriter, r *http.Request) {
		delMethod, delPath = r.Method, r.URL.Path
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "revoked", "id": "fb2"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})

	// List
	page, err := r.FederationBindings.List(context.Background()).Page(context.Background(), nil)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if listMethod != "GET" || len(page.Items) != 1 || page.Items[0].ID != "fb1" || page.Items[0].MatchClaims["repository"] != "acme/billing" {
		t.Errorf("unexpected list: %s %+v", listMethod, page.Items)
	}

	// Create
	fb, err := r.FederationBindings.Create(context.Background(), FederationBindingCreate{
		Issuer:      "https://token.actions.githubusercontent.com",
		MatchClaims: map[string]string{"repository": "acme/billing"},
		MappedRole:  "platform_api",
		Scope:       []string{"read"},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if createMethod != "POST" || fb.ID != "fb2" || fb.Audience != "ri-const" || fb.Status != "active" {
		t.Errorf("unexpected create: %s %+v", createMethod, fb)
	}
	if createBody["issuer"] != "https://token.actions.githubusercontent.com" {
		t.Errorf("create body issuer: %v", createBody["issuer"])
	}
	mc, _ := createBody["match_claims"].(map[string]any)
	if mc == nil || mc["repository"] != "acme/billing" {
		t.Errorf("create body match_claims: %v", createBody["match_claims"])
	}

	// Revoke
	res, err := r.FederationBindings.Revoke(context.Background(), "fb2")
	if err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if delMethod != "DELETE" || delPath != base+"/fb2" || res.Status != "revoked" || res.ID != "fb2" {
		t.Errorf("unexpected revoke: %s %s %+v", delMethod, delPath, res)
	}
}
