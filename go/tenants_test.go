package realmid

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTenants_ListPaginatesAcrossPages(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "subject_type": "platform", "refresh_token": "rtok-platform", "access_token": "ptok", "expires_in": 300})
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
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "subject_type": "platform", "refresh_token": "rtok-platform", "access_token": "ptok", "expires_in": 300})
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
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "subject_type": "platform", "refresh_token": "rtok-platform", "access_token": "ptok", "expires_in": 300})
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
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "subject_type": "platform", "refresh_token": "rtok-platform", "access_token": "ptok", "expires_in": 300})
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

// TestInvitations_CreateUsesIdentifier verifies the v0.11.0 invite shape:
// the body carries `identifier` (not `email`) and the response decodes
// {id, identifier, role, status, expires_at}.
func TestInvitations_CreateUsesIdentifier(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "subject_type": "platform", "refresh_token": "rtok-platform", "access_token": "ptok", "expires_in": 300})
	})
	var gotMethod, gotPath string
	var gotBody map[string]string
	mux.HandleFunc("/tenants/t1/invitations", func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "u-new", "identifier": "[email protected]", "role": "member", "status": "pending", "expires_at": 1700000000,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	inv, err := r.Tenants.Invitations.Create(context.Background(), "t1", InvitationCreate{Identifier: "[email protected]", Role: "member"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if gotMethod != "POST" || gotPath != "/tenants/t1/invitations" {
		t.Errorf("wrong wire call: %s %s", gotMethod, gotPath)
	}
	if gotBody["identifier"] != "[email protected]" {
		t.Errorf("body should carry identifier, got %+v", gotBody)
	}
	if _, ok := gotBody["email"]; ok {
		t.Errorf("body must not carry legacy email field: %+v", gotBody)
	}
	if inv.ID != "u-new" || inv.Identifier != "[email protected]" || inv.Status != "pending" || inv.ExpiresAt != 1700000000 {
		t.Errorf("unexpected invitation: %+v", inv)
	}
}

// TestUpdateUserContact verifies PATCH /tenants/{id}/users/{uid} with an
// email/phone body decodes the updated User.
func TestUpdateUserContact(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "subject_type": "platform", "refresh_token": "rtok-platform", "access_token": "ptok", "expires_in": 300})
	})
	var gotMethod, gotPath string
	var gotBody map[string]string
	mux.HandleFunc("/tenants/t1/users/u9", func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "u9", "email": "[email protected]", "phone": "+15551234567", "role": "member", "status": "active",
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	u, err := r.Tenants.UpdateUserContact(context.Background(), "t1", "u9", UpdateContactInput{Email: "[email protected]", Phone: "+15551234567"})
	if err != nil {
		t.Fatalf("UpdateUserContact: %v", err)
	}
	if gotMethod != "PATCH" || gotPath != "/tenants/t1/users/u9" {
		t.Errorf("wrong wire call: %s %s", gotMethod, gotPath)
	}
	if gotBody["email"] != "[email protected]" || gotBody["phone"] != "+15551234567" {
		t.Errorf("wrong body: %+v", gotBody)
	}
	if u.ID != "u9" || u.Email != "[email protected]" || u.Phone != "+15551234567" {
		t.Errorf("unexpected user: %+v", u)
	}
}

// TestDriftReviews_AcceptAndList covers the drift-review list (with
// user_id filter) plus the accept action (SPEC §6.8).
func TestDriftReviews_AcceptAndList(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "subject_type": "platform", "refresh_token": "rtok-platform", "access_token": "ptok", "expires_in": 300})
	})
	var listQuery string
	mux.HandleFunc("/tenants/t1/contact-drift-reviews", func(w http.ResponseWriter, r *http.Request) {
		listQuery = r.URL.RawQuery
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []any{
				map[string]any{
					"id": "dr1", "contact_id": "c1", "user_id": "u9",
					"asserted_value": "[email protected]", "asserted_method": "email",
					"asserted_provider_uid": "google|123", "seen_count": 3,
					"first_seen_at": 1700000000, "last_seen_at": 1700009999, "status": "pending",
				},
			},
			"next_cursor": "",
		})
	})
	var acceptMethod, acceptPath string
	mux.HandleFunc("/tenants/t1/contact-drift-reviews/dr1/accept", func(w http.ResponseWriter, r *http.Request) {
		acceptMethod = r.Method
		acceptPath = r.URL.Path
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "dr1", "status": "accepted", "accepted_value": "[email protected]", "new_contact_id": "c2",
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})

	page, err := r.Tenants.DriftReviews.List(context.Background(), "t1", &DriftReviewListOpts{UserID: "u9", Limit: 25}).Page(context.Background(), nil)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != "dr1" || page.Items[0].SeenCount != 3 || page.Items[0].AssertedValue != "[email protected]" {
		t.Errorf("unexpected list page: %+v", page.Items)
	}
	if !strings.Contains(listQuery, "user_id=u9") || !strings.Contains(listQuery, "limit=25") {
		t.Errorf("list query missing filters: %q", listQuery)
	}

	res, err := r.Tenants.DriftReviews.Accept(context.Background(), "t1", "dr1")
	if err != nil {
		t.Fatalf("Accept: %v", err)
	}
	if acceptMethod != "POST" || acceptPath != "/tenants/t1/contact-drift-reviews/dr1/accept" {
		t.Errorf("wrong wire call: %s %s", acceptMethod, acceptPath)
	}
	if res.Status != "accepted" || res.AcceptedValue != "[email protected]" || res.NewContactID != "c2" {
		t.Errorf("unexpected accept result: %+v", res)
	}
}

// TestContactVerifications_Approve covers the step-up approve action and
// the state filter on list (SPEC §6.9).
func TestContactVerifications_Approve(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "subject_type": "platform", "refresh_token": "rtok-platform", "access_token": "ptok", "expires_in": 300})
	})
	var listQuery string
	mux.HandleFunc("/tenants/t1/contact-verifications", func(w http.ResponseWriter, r *http.Request) {
		listQuery = r.URL.RawQuery
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []any{
				map[string]any{
					"id": "cv1", "contact_id": "c1", "user_id": "u9", "method": "email",
					"provider_uid": "google|123", "state": "pending",
					"created_at": 1700000000, "expires_at": 1700003600,
				},
			},
			"next_cursor": "",
		})
	})
	var apMethod, apPath string
	mux.HandleFunc("/tenants/t1/contact-verifications/cv1/approve", func(w http.ResponseWriter, r *http.Request) {
		apMethod = r.Method
		apPath = r.URL.Path
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "cv1", "state": "active"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})

	page, err := r.Tenants.ContactVerifications.List(context.Background(), "t1", &ContactVerificationListOpts{State: "pending"}).Page(context.Background(), nil)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != "cv1" || page.Items[0].State != "pending" || page.Items[0].ExpiresAt != 1700003600 {
		t.Errorf("unexpected list page: %+v", page.Items)
	}
	if !strings.Contains(listQuery, "state=pending") {
		t.Errorf("list query missing state filter: %q", listQuery)
	}

	res, err := r.Tenants.ContactVerifications.Approve(context.Background(), "t1", "cv1")
	if err != nil {
		t.Fatalf("Approve: %v", err)
	}
	if apMethod != "POST" || apPath != "/tenants/t1/contact-verifications/cv1/approve" {
		t.Errorf("wrong wire call: %s %s", apMethod, apPath)
	}
	if res.ID != "cv1" || res.State != "active" {
		t.Errorf("unexpected approve result: %+v", res)
	}
}

// TestTenants_TransferOwner verifies the ADR-076 direct transfer body:
// owner_user_id always, plus the optional outgoing_owner_role /
// leave_entirely knobs only when supplied.
func TestTenants_TransferOwner(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "subject_type": "platform", "refresh_token": "rtok-platform", "access_token": "ptok", "expires_in": 300})
	})
	var gotBody map[string]any
	var gotMethod, gotPath string
	mux.HandleFunc("/tenants/t1/owner", func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "t1", "owner_user_id": "u-new"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})

	// nil opts → owner_user_id only.
	tnt, err := r.Tenants.TransferOwner(context.Background(), "t1", "u-new", nil)
	if err != nil {
		t.Fatalf("TransferOwner: %v", err)
	}
	if gotMethod != "PUT" || gotPath != "/tenants/t1/owner" {
		t.Errorf("wrong wire call: %s %s", gotMethod, gotPath)
	}
	if tnt.OwnerUserID != "u-new" {
		t.Errorf("unexpected tenant: %+v", tnt)
	}
	if gotBody["owner_user_id"] != "u-new" {
		t.Errorf("body owner_user_id: %v", gotBody["owner_user_id"])
	}
	if _, ok := gotBody["outgoing_owner_role"]; ok {
		t.Errorf("outgoing_owner_role should be omitted when unset, got %v", gotBody)
	}
	if _, ok := gotBody["leave_entirely"]; ok {
		t.Errorf("leave_entirely should be omitted when false, got %v", gotBody)
	}

	// opts → both knobs present.
	_, err = r.Tenants.TransferOwner(context.Background(), "t1", "u-new", &TransferOwnerOptions{
		OutgoingOwnerRole: "admin",
		LeaveEntirely:     true,
	})
	if err != nil {
		t.Fatalf("TransferOwner opts: %v", err)
	}
	if gotBody["outgoing_owner_role"] != "admin" {
		t.Errorf("body outgoing_owner_role: %v", gotBody["outgoing_owner_role"])
	}
	if gotBody["leave_entirely"] != true {
		t.Errorf("body leave_entirely: %v", gotBody["leave_entirely"])
	}
}
