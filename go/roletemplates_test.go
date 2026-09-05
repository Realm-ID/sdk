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

func templatesURL() string { return "/platforms/" + testRealmID + "/role-templates" }

func TestRoleTemplates_ListPassesLevelAndNeverReturnsNil(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc(templatesURL(), func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Errorf("method=%s", r.Method)
		}
		if lv := r.URL.Query().Get("level"); lv != "tenant" {
			t.Errorf("level=%q, want tenant", lv)
		}
		// An empty vocabulary comes back as a JSON null, which is the shape that
		// turns into a nil slice and panics an iterating caller.
		_ = json.NewEncoder(w).Encode(map[string]any{"role_templates": nil})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.RoleTemplates.List(context.Background(), RoleTemplateLevelTenant)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if out == nil {
		t.Fatal("a null role_templates must normalize to an empty slice, not nil")
	}
	if len(out) != 0 {
		t.Fatalf("len=%d", len(out))
	}
}

// RealmsStamped is the difference between "the role exists for future realms"
// and "the role reached the realms that already exist". Only the second is what
// ADR-101 promises, so the SDK must surface it rather than drop it.
func TestRoleTemplates_CreateSurfacesRealmsStamped(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc(templatesURL(), func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("method=%s", r.Method)
		}
		body, _ := io.ReadAll(r.Body)
		var got map[string]any
		_ = json.Unmarshal(body, &got)
		if got["level"] != "tenant" || got["name"] != "reporting" {
			t.Errorf("body did not carry the identity: %s", string(body))
		}
		// assignable_to has no omitempty — it is REQUIRED, and a body that
		// silently omits it is a 400 the caller cannot diagnose.
		if _, ok := got["assignable_to"]; !ok {
			t.Errorf("assignable_to must always be sent: %s", string(body))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"role_template": map[string]any{
				"id": "tpl1", "level": "tenant", "name": "reporting",
				"display_name": "Reporting", "permissions": []string{"audit:read"},
				"assignable_to": []string{"human"}, "is_system": false, "optional": false,
			},
			"realms_stamped": 7,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.RoleTemplates.Create(context.Background(), RoleTemplateCreate{
		Level: RoleTemplateLevelTenant, Name: "reporting", DisplayName: "Reporting",
		Permissions: []string{"audit:read"}, AssignableTo: []string{"human"},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if out.RealmsStamped != 7 {
		t.Fatalf("realms_stamped = %d, want 7", out.RealmsStamped)
	}
	if out.RoleTemplate.Name != "reporting" {
		t.Fatalf("template = %+v", out.RoleTemplate)
	}
}

// -1 means "could not count" and must survive as -1. Coercing it to 0 would
// turn "unknown" into "none" — a clean bill of health nobody issued.
func TestRoleTemplates_UpdateKeepsUncountableDriftAsMinusOne(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc(templatesURL()+"/tpl1", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"role_template": map[string]any{
				"id": "tpl1", "level": "tenant", "name": "reporting",
				"assignable_to": []string{"human"},
			},
			"drifted_realms": -1,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	dn := "Reporting v2"
	out, err := r.RoleTemplates.Update(context.Background(), "tpl1",
		RoleTemplatePatch{DisplayName: &dn})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if out.DriftedRealms != -1 {
		t.Fatalf("drifted_realms = %d, want -1 preserved (unknown, NOT none)", out.DriftedRealms)
	}
}

func TestRoleTemplates_PatchOmitsUnsetFields(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	var body map[string]any
	mux.HandleFunc(templatesURL()+"/tpl1", func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"role_template":  map[string]any{"id": "tpl1", "level": "tenant", "name": "x"},
			"drifted_realms": 0,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	dn := "only this"
	if _, err := r.RoleTemplates.Update(context.Background(), "tpl1",
		RoleTemplatePatch{DisplayName: &dn}); err != nil {
		t.Fatalf("update: %v", err)
	}
	// An omitted key must be ABSENT, not null: absent preserves the stored
	// value, and a sent null would be a decision the caller did not make.
	for _, k := range []string{"permissions", "assignable_to", "is_system", "optional"} {
		if _, present := body[k]; present {
			t.Errorf("unset field %q must be omitted from the patch body, got %v", k, body[k])
		}
	}
	if body["display_name"] != "only this" {
		t.Errorf("display_name not sent: %v", body)
	}
}

func TestRoleTemplates_DeleteReportsOrphans(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc(templatesURL()+"/tpl1", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "DELETE" {
			t.Errorf("method=%s", r.Method)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "deleted", "realms_still_holding": 3,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.RoleTemplates.Delete(context.Background(), "tpl1")
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if out.RealmsStillHolding != 3 {
		t.Fatalf("realms_still_holding = %d, want 3", out.RealmsStillHolding)
	}
}

// The error mapping, per code. The NESTED envelope shape is used deliberately:
// a code that lives only inside `error` and not at the top level is the exact
// shape that made role_owner_only arrive as a plain `forbidden`.
func TestRoleTemplates_ErrorsMapToSentinels(t *testing.T) {
	for _, tc := range []struct {
		code   string
		status int
		want   error
	}{
		{"role_template_exists", 409, ErrRoleTemplateExists},
		{"role_template_not_found", 404, ErrRoleTemplateNotFound},
		{"role_template_identity_immutable", 400, ErrRoleTemplateIdentityImmutable},
		{"role_templates_unavailable", 501, ErrRoleTemplatesUnavailable},
		{"role_authoring_retired", 403, ErrRoleAuthoringRetired},
		// Registered 2026-09-05 for issuer v0.121.0. The two are NOT
		// interchangeable: role_template_seated is a recoverable conflict
		// (override_seated=true rescues it); role_template_seat_check_failed
		// is unconditional (no parameter rescues it — the count itself could
		// not be taken).
		{"role_template_seated", 409, ErrRoleTemplateSeated},
		{"role_template_seat_check_failed", 503, ErrRoleTemplateSeatCheckFailed},
	} {
		t.Run(tc.code, func(t *testing.T) {
			mux := http.NewServeMux()
			mintPlatformToken(mux)
			mux.HandleFunc(templatesURL(), func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"error": map[string]any{"code": tc.code, "message": "nope"},
				})
			})
			srv := httptest.NewServer(mux)
			defer srv.Close()

			r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
			_, err := r.RoleTemplates.Create(context.Background(), RoleTemplateCreate{
				Level: RoleTemplateLevelTenant, Name: "x", AssignableTo: []string{"human"},
			})
			if !errors.Is(err, tc.want) {
				t.Fatalf("code %q: got %v, want errors.Is(_, %v)", tc.code, err, tc.want)
			}
		})
	}
}

// ADR-101 D4 shipped in issuer v0.113.0 and the AUTHORING routes returned
// role_authoring_retired with no SDK sentinel at all, so every caller had to
// string-match a 403. Asserted on the roles surface, not just the templates
// one, because that is where a partner actually hits it.
func TestRoles_AuthoringRetiredMapsSentinel(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc("/platforms/"+testRealmID+"/roles", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(403)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"code":    "role_authoring_retired",
				"message": "RealmID defines the role set",
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	_, err := r.Roles.Create(context.Background(), RoleCreate{Name: "salesman"})
	if !errors.Is(err, ErrRoleAuthoringRetired) {
		t.Fatalf("got %v, want ErrRoleAuthoringRetired", err)
	}
}
