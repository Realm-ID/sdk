package realmid

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"testing"
)

func TestAuth_SelfEnrollMFA_Happy(t *testing.T) {
	var gotAuth string
	var gotBody map[string]any
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/mfa/enroll": func(w http.ResponseWriter, r *http.Request) {
			if r.Method != "POST" {
				t.Errorf("method=%s", r.Method)
			}
			gotAuth = r.Header.Get("Authorization")
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &gotBody)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"secret":              "JBSWY3DPEHPK3PXP",
				"qr_url":              "otpauth://totp/realm:u1?secret=JBSWY3DPEHPK3PXP",
				"recovery_codes":      []string{"aaaa-bbbb", "cccc-dddd"},
				"mfa_challenge_token": "enroll-chal-xyz",
				"tenant_id":           "t1",
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.Auth.SelfEnrollMFA(context.Background(), SelfEnrollMFARequest{
		RefreshToken: "rt-123", TenantID: "t1",
	})
	if err != nil {
		t.Fatalf("self-enroll: %v", err)
	}
	if out.Secret != "JBSWY3DPEHPK3PXP" || out.QRURL == "" || len(out.RecoveryCodes) != 2 {
		t.Errorf("out=%+v", out)
	}
	if out.MFAChallengeToken != "enroll-chal-xyz" || out.TenantID != "t1" {
		t.Errorf("challenge/tenant not surfaced: %+v", out)
	}
	// Refresh-authed: platform token is the bearer; refresh + tenant ride the body.
	if gotAuth != "Bearer ptok" {
		t.Errorf("auth=%q (want platform token)", gotAuth)
	}
	if gotBody["refresh_token"] != "rt-123" || gotBody["tenant_id"] != "t1" {
		t.Errorf("body missing refresh/tenant: %v", gotBody)
	}
	// Method empty → must be omitted from the wire body.
	if _, has := gotBody["method"]; has {
		t.Errorf("method should be omitted when empty: %v", gotBody)
	}
}

func TestAuth_SelfEnrollMFA_AlreadyEnrolled(t *testing.T) {
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/mfa/enroll": func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": map[string]any{"code": "conflict", "message": "already enrolled"},
				"code":  "already_enrolled",
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	_, err := r.Auth.SelfEnrollMFA(context.Background(), SelfEnrollMFARequest{RefreshToken: "rt", TenantID: "t1"})
	if err == nil {
		t.Fatal("expected error")
	}
	if !IsCode(err, ErrCodeConflict) {
		t.Errorf("want conflict code, got %v", err)
	}
}

func TestAuth_DisableMFA_SendsCodeOnDelete(t *testing.T) {
	var gotMethod, gotAuth string
	var gotBody map[string]any
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/mfa": func(w http.ResponseWriter, r *http.Request) {
			gotMethod = r.Method
			gotAuth = r.Header.Get("Authorization")
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &gotBody)
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "disabled"})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	err := r.Auth.DisableMFA(WithUserToken(context.Background(), "user-jwt"), DisableMFARequest{UserID: "u9", Code: "654321"})
	if err != nil {
		t.Fatalf("disable: %v", err)
	}
	if gotMethod != "DELETE" {
		t.Errorf("method=%s", gotMethod)
	}
	if gotBody["code"] != "654321" {
		t.Errorf("DELETE body must carry code: %v", gotBody)
	}
	if gotAuth != "Bearer ptok" {
		t.Errorf("auth=%q", gotAuth)
	}
}

func TestAuth_DisableMFA_NotEnrolled(t *testing.T) {
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/mfa": func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": map[string]any{"code": "bad_request", "message": "not enrolled"},
				"code":  "not_enrolled",
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	err := r.Auth.DisableMFA(context.Background(), DisableMFARequest{UserBearer: "u-jwt", Code: "111111"})
	if err == nil {
		t.Fatal("expected error")
	}
	if !IsCode(err, ErrCodeBadRequest) {
		t.Errorf("want bad_request, got %v", err)
	}
}

func TestAuth_RevokeAllSessions_OnBehalfOf(t *testing.T) {
	var gotMethod, gotAuth, gotOBO string
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/sessions": func(w http.ResponseWriter, r *http.Request) {
			gotMethod = r.Method
			gotAuth = r.Header.Get("Authorization")
			gotOBO = r.Header.Get("X-On-Behalf-Of-User")
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	err := r.Auth.RevokeAllSessions(WithUserToken(context.Background(), "user-jwt"), RevokeAllSessionsRequest{UserID: "u-42"})
	if err != nil {
		t.Fatalf("revoke-all: %v", err)
	}
	if gotMethod != "DELETE" {
		t.Errorf("method=%s", gotMethod)
	}
	if gotAuth != "Bearer ptok" || gotOBO != "u-42" {
		t.Errorf("auth=%q obo=%q", gotAuth, gotOBO)
	}
}

func TestAuth_RevokeAllSessions_RequiresSelector(t *testing.T) {
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: "http://unused"})
	err := r.Auth.RevokeAllSessions(context.Background(), RevokeAllSessionsRequest{})
	var re *RealmError
	if !errors.As(err, &re) || re.Code != ErrCodeBadRequest {
		t.Errorf("want bad_request, got %v", err)
	}
}
