package realmid

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"testing"
)

func TestOTP_Issue(t *testing.T) {
	var gotBody map[string]any
	var gotBearer, gotOBO string
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/otp/issue": func(w http.ResponseWriter, r *http.Request) {
			gotBearer = r.Header.Get("Authorization")
			gotOBO = r.Header.Get("X-On-Behalf-Of-User")
			buf, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(buf, &gotBody)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":          "otp-1",
				"value":       "123456",
				"expires_at":  "2026-05-08T12:00:00Z",
				"purpose":     "delivery",
				"subject_ref": "booking:X",
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	resp, err := r.OTP.Issue(context.Background(), IssueRequest{
		SubjectRef: "booking:X",
		Purpose:    "delivery",
		UserID:     "manager-A",
	})
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if resp.Value != "123456" || resp.ID != "otp-1" {
		t.Errorf("resp: %+v", resp)
	}
	if gotBody["subject_ref"] != "booking:X" || gotBody["purpose"] != "delivery" {
		t.Errorf("body: %+v", gotBody)
	}
	if gotBearer != "Bearer ptok" {
		t.Errorf("bearer: %q", gotBearer)
	}
	if gotOBO != "manager-A" {
		t.Errorf("on-behalf-of: %q", gotOBO)
	}
	if resp.ExpiresAt.IsZero() {
		t.Error("ExpiresAt not parsed")
	}
}

func TestOTP_Verify_Success(t *testing.T) {
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/otp/verify": func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"otp_id":         "otp-1",
				"issuer_user_id": "manager-A",
				"issued_at":      "2026-05-08T11:00:00Z",
				"subject_ref":    "booking:X",
				"purpose":        "delivery",
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	resp, err := r.OTP.Verify(context.Background(), VerifyRequest{
		SubjectRef: "booking:X", Purpose: "delivery", Presented: "123456",
		UserID: "agent-svc",
	})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if resp.IssuerUserID != "manager-A" {
		t.Errorf("issuer = %q", resp.IssuerUserID)
	}
}

func TestOTP_Verify_Invalid(t *testing.T) {
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/otp/verify": func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": map[string]any{"code": "invalid_otp", "message": "invalid OTP"},
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	_, err := r.OTP.Verify(context.Background(), VerifyRequest{
		SubjectRef: "booking:X", Purpose: "delivery", Presented: "wrong",
		UserBearer: "user-jwt",
	})
	var re *RealmError
	if !errors.As(err, &re) {
		t.Fatalf("expected RealmError, got %v", err)
	}
	if re.Code != "invalid_otp" {
		t.Errorf("code = %q", re.Code)
	}
}

func TestOTP_View_IssuerOnly(t *testing.T) {
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/otp/otp-1": func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":             "otp-1",
				"value":          "654321",
				"expires_at":     "2026-05-08T12:00:00Z",
				"purpose":        "login",
				"subject_ref":    "user:bob",
				"issuer_user_id": "manager-A",
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	resp, err := r.OTP.View(context.Background(), "otp-1", ViewOptions{UserID: "manager-A"})
	if err != nil {
		t.Fatalf("View: %v", err)
	}
	if resp.Value != "654321" || resp.IssuerUserID != "manager-A" {
		t.Errorf("resp: %+v", resp)
	}
}
