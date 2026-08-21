package realmid

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

func TestSessions_RevokeUser(t *testing.T) {
	var gotMethod, gotAuth string
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/tenants/t1/users/u9/sessions/revoke": func(w http.ResponseWriter, r *http.Request) {
			gotMethod = r.Method
			gotAuth = r.Header.Get("Authorization")
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "revoked": 3})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.Sessions.RevokeUser(context.Background(), "t1", "u9")
	if err != nil {
		t.Fatalf("revoke-user: %v", err)
	}
	if gotMethod != "POST" || gotAuth != "Bearer ptok" {
		t.Errorf("method=%s auth=%q", gotMethod, gotAuth)
	}
	if out.Status != "ok" || out.Revoked != 3 {
		t.Errorf("out=%+v", out)
	}
}

func TestSessions_RevokeAll(t *testing.T) {
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/platforms/" + testRealmID + "/sessions/revoke-all": func(w http.ResponseWriter, r *http.Request) {
			if r.Method != "POST" {
				t.Errorf("method=%s", r.Method)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "revoked": 42})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.Sessions.RevokeAll(context.Background())
	if err != nil {
		t.Fatalf("revoke-all: %v", err)
	}
	if out.Revoked != 42 {
		t.Errorf("out=%+v", out)
	}
}

func TestUsers_DelinkContact(t *testing.T) {
	var gotMethod string
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/tenants/t1/users/u1/contacts/c7/delink": func(w http.ResponseWriter, r *http.Request) {
			gotMethod = r.Method
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "delinked", "contact_id": "c7", "revoked_bindings": 1})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.Tenants.Users.DelinkContact(context.Background(), "t1", "u1", "c7")
	if err != nil {
		t.Fatalf("delink: %v", err)
	}
	if gotMethod != "POST" {
		t.Errorf("method=%s", gotMethod)
	}
	if out.Status != "delinked" || out.ContactID != "c7" || out.RevokedBindings != 1 {
		t.Errorf("out=%+v", out)
	}
}

func TestUsers_HandBack(t *testing.T) {
	var gotBody map[string]any
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/tenants/t1/users/old/hand-back": func(w http.ResponseWriter, r *http.Request) {
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &gotBody)
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "handed_back", "user_id": "old", "email": "u@corp.test"})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.Tenants.Users.HandBack(context.Background(), "t1", "old", "new")
	if err != nil {
		t.Fatalf("hand-back: %v", err)
	}
	if gotBody["from_user_id"] != "new" {
		t.Errorf("body must carry from_user_id: %v", gotBody)
	}
	if out.Status != "handed_back" || out.UserID != "old" || out.Email != "u@corp.test" {
		t.Errorf("out=%+v", out)
	}
}

func TestDriftReviews_RejectSoftAndHard(t *testing.T) {
	var lastBody map[string]any
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/tenants/t1/contact-drift-reviews/rv1/reject": func(w http.ResponseWriter, r *http.Request) {
			lastBody = nil
			raw, _ := io.ReadAll(r.Body)
			if len(raw) > 0 {
				_ = json.Unmarshal(raw, &lastBody)
			}
			if lastBody["hard"] == true {
				_ = json.NewEncoder(w).Encode(map[string]any{"id": "rv1", "status": "rejected", "mode": "hard", "parked": true, "revoked_bindings": 2})
			} else {
				_ = json.NewEncoder(w).Encode(map[string]any{"id": "rv1", "status": "rejected", "mode": "soft"})
			}
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	soft, err := r.Tenants.DriftReviews.Reject(context.Background(), "t1", "rv1")
	if err != nil {
		t.Fatalf("soft reject: %v", err)
	}
	if soft.Mode != "soft" || soft.Parked {
		t.Errorf("soft=%+v", soft)
	}
	if lastBody["hard"] == true {
		t.Errorf("soft reject must not send hard:true, body=%v", lastBody)
	}

	hard, err := r.Tenants.DriftReviews.RejectHard(context.Background(), "t1", "rv1")
	if err != nil {
		t.Fatalf("hard reject: %v", err)
	}
	if hard.Mode != "hard" || !hard.Parked || hard.RevokedBindings != 2 {
		t.Errorf("hard=%+v", hard)
	}
	if lastBody["hard"] != true {
		t.Errorf("hard reject must send hard:true, body=%v", lastBody)
	}
}

func TestAuth_ListAuthenticators(t *testing.T) {
	var gotOBO string
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/mfa/authenticators": func(w http.ResponseWriter, r *http.Request) {
			if r.Method != "GET" {
				t.Errorf("method=%s", r.Method)
			}
			gotOBO = r.Header.Get("X-On-Behalf-Of-User")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"authenticators": []any{
					map[string]any{"type": "totp", "confirmed": true, "created_at": 1000, "confirmed_at": 1001},
				},
				"backup_codes_remaining": 8,
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.Auth.ListAuthenticators(WithUserToken(context.Background(), "user-jwt"), ListAuthenticatorsRequest{UserID: "u5"})
	if err != nil {
		t.Fatalf("list-authenticators: %v", err)
	}
	if gotOBO != "u5" {
		t.Errorf("obo=%q", gotOBO)
	}
	if out.BackupCodesRemaining != 8 || len(out.Authenticators) != 1 || out.Authenticators[0].Type != "totp" || !out.Authenticators[0].Confirmed {
		t.Errorf("out=%+v", out)
	}
}

func TestAuth_RegenerateRecoveryCodes(t *testing.T) {
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/mfa/recovery/regenerate": func(w http.ResponseWriter, r *http.Request) {
			if r.Method != "POST" {
				t.Errorf("method=%s", r.Method)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "recovery_codes": []string{"aaaa-1111", "bbbb-2222"}})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.Auth.RegenerateRecoveryCodes(WithUserToken(context.Background(), "user-jwt"), RegenerateRecoveryCodesRequest{UserID: "u5"})
	if err != nil {
		t.Fatalf("regenerate: %v", err)
	}
	if out.Status != "ok" || len(out.RecoveryCodes) != 2 {
		t.Errorf("out=%+v", out)
	}
}

func TestAuth_RegenerateRecoveryCodes_MFARequired(t *testing.T) {
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/mfa/recovery/regenerate": func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusPreconditionFailed)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": map[string]any{"code": "mfa_required", "message": "fresh TOTP required"},
				"code":  "mfa_required",
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	_, err := r.Auth.RegenerateRecoveryCodes(WithUserToken(context.Background(), "user-jwt"), RegenerateRecoveryCodesRequest{UserID: "u5"})
	if !IsCode(err, ErrCodeMFARequired) {
		t.Errorf("want mfa_required, got %v", err)
	}
}

func TestErrCodeContactAdminRequired(t *testing.T) {
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/login": func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusConflict)
			// Real issuer envelope: {"error": "<msg string>", "code": "<specific>"}.
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": "this identifier is managed by your organisation; contact your admin",
				"code":  "contact_admin_required",
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	_, err := r.Auth.Login(context.Background(), LoginRequest{Method: LoginGoogle, ProviderToken: "x", TenantID: "t1"})
	if !IsCode(err, ErrCodeContactAdminRequired) {
		t.Errorf("want contact_admin_required, got %v", err)
	}
}
