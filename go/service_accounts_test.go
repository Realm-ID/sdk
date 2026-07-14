package realmid

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"testing"
)

// TestServiceAccounts_Create asserts the create path posts to the tenant
// service-accounts route and decodes the account.
func TestServiceAccounts_Create(t *testing.T) {
	var gotBody map[string]any
	var gotPath string
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/tenants/t1/service-accounts": func(w http.ResponseWriter, r *http.Request) {
			gotPath = r.URL.Path
			buf, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(buf, &gotBody)
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "sa-1", "handle": "bot@acme.test", "role": "member",
				"status": "active", "kind": "service",
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.ServiceAccounts.Create(context.Background(), "t1", ServiceAccountCreate{
		Handle: "bot@acme.test", Role: "member",
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if gotPath != "/tenants/t1/service-accounts" {
		t.Errorf("path = %q", gotPath)
	}
	if gotBody["handle"] != "bot@acme.test" {
		t.Errorf("body handle = %v", gotBody["handle"])
	}
	if out.ID != "sa-1" || out.Kind != "service" {
		t.Errorf("decoded = %+v", out)
	}
}

// TestServiceAccounts_HandleTakenMapsSentinel asserts a 409 handle_taken maps
// to the ErrServiceAccountHandleTaken sentinel.
func TestServiceAccounts_HandleTakenMapsSentinel(t *testing.T) {
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/tenants/t1/service-accounts": func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"code": "handle_taken", "message": "taken"}})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	_, err := r.ServiceAccounts.Create(context.Background(), "t1", ServiceAccountCreate{Handle: "x@y.z"})
	if !errors.Is(err, ErrServiceAccountHandleTaken) {
		t.Fatalf("want ErrServiceAccountHandleTaken, got %v", err)
	}
}

// TestServiceAccounts_Lifecycle covers the action verbs' route shapes.
func TestServiceAccounts_Lifecycle(t *testing.T) {
	seen := map[string]bool{}
	handler := func(w http.ResponseWriter, r *http.Request) {
		seen[r.Method+" "+r.URL.Path] = true
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "sa-1", "kind": "service", "status": "active"})
	}
	revoke := func(w http.ResponseWriter, r *http.Request) {
		seen[r.Method+" "+r.URL.Path] = true
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "revoked_sessions": 2})
	}
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/tenants/t1/service-accounts/sa-1/suspend":      handler,
		"/tenants/t1/service-accounts/sa-1/unsuspend":    handler,
		"/tenants/t1/service-accounts/sa-1/deactivate":   handler,
		"/tenants/t1/service-accounts/sa-1/reset-handle": handler,
		"/tenants/t1/service-accounts/sa-1/revoke":       revoke,
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	ctx := context.Background()
	if _, err := r.ServiceAccounts.Suspend(ctx, "t1", "sa-1"); err != nil {
		t.Fatalf("Suspend: %v", err)
	}
	if _, err := r.ServiceAccounts.Unsuspend(ctx, "t1", "sa-1"); err != nil {
		t.Fatalf("Unsuspend: %v", err)
	}
	if _, err := r.ServiceAccounts.Deactivate(ctx, "t1", "sa-1"); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}
	if _, err := r.ServiceAccounts.ResetHandle(ctx, "t1", "sa-1", "new@acme.test"); err != nil {
		t.Fatalf("ResetHandle: %v", err)
	}
	rev, err := r.ServiceAccounts.Revoke(ctx, "t1", "sa-1")
	if err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if rev.RevokedSessions != 2 {
		t.Errorf("revoked_sessions = %d", rev.RevokedSessions)
	}
	for _, want := range []string{
		"POST /tenants/t1/service-accounts/sa-1/suspend",
		"POST /tenants/t1/service-accounts/sa-1/unsuspend",
		"POST /tenants/t1/service-accounts/sa-1/deactivate",
		"POST /tenants/t1/service-accounts/sa-1/reset-handle",
		"POST /tenants/t1/service-accounts/sa-1/revoke",
	} {
		if !seen[want] {
			t.Errorf("missing call: %s", want)
		}
	}
}

// TestOTP_Issue_DeliveryMode asserts delivery_mode threads onto the issue body.
func TestOTP_Issue_DeliveryMode(t *testing.T) {
	var gotBody map[string]any
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/otp/issue": func(w http.ResponseWriter, r *http.Request) {
			buf, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(buf, &gotBody)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "otp-1", "value": "123456", "expires_at": "2026-07-14T00:00:00Z",
				"purpose": "login", "subject_ref": "user:sa-1",
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	_, err := r.OTP.Issue(context.Background(), IssueRequest{
		SubjectRef: "user:sa-1", Purpose: "login",
		DeliveryMode: DeliveryModeViewBFF, UserID: "u-owner",
	})
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if gotBody["delivery_mode"] != "view_bff" {
		t.Errorf("delivery_mode = %v, want view_bff", gotBody["delivery_mode"])
	}
}

// TestSession_DecodesInitiatedByUserID asserts the provenance field decodes.
func TestSession_DecodesInitiatedByUserID(t *testing.T) {
	var s Session
	if err := json.Unmarshal([]byte(`{"access_token":"a","initiated_by_user_id":"u-owner"}`), &s); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if s.InitiatedByUserID != "u-owner" {
		t.Errorf("InitiatedByUserID = %q", s.InitiatedByUserID)
	}
}
