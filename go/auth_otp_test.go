package realmid

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

// TestAuth_OTPLogin_SendsCorrectBody asserts the SDK threads identifier +
// presented + grant_type=otp_internal through to /auth/login (partner OTP
// proposal §3.2.1; ADR-051 canonical grant_type, not legacy `method`).
func TestAuth_OTPLogin_SendsCorrectBody(t *testing.T) {
	var gotBody map[string]any
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/login": func(w http.ResponseWriter, r *http.Request) {
			buf, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(buf, &gotBody)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":  "atok",
				"refresh_token": "rtok",
				"expires_in":    900,
				"user":          map[string]any{"id": "u-bob"},
				"tenants":       []any{map[string]any{"id": "t1", "role": "member"}},
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.Auth.OTPLogin(context.Background(), OTPLoginRequest{
		Identifier: "+15551234567",
		Presented:  "123456",
	})
	if err != nil {
		t.Fatalf("OTPLogin: %v", err)
	}
	if out.AccessToken != "atok" {
		t.Errorf("access_token = %q", out.AccessToken)
	}
	if gotBody["grant_type"] != "otp_internal" {
		t.Errorf("grant_type = %v, want otp_internal", gotBody["grant_type"])
	}
	if gotBody["method"] != nil {
		t.Errorf("OTPLogin must not send the deprecated `method` field, got: %v", gotBody["method"])
	}
	if gotBody["identifier"] != "+15551234567" || gotBody["presented"] != "123456" {
		t.Errorf("body missing identifier/presented: %+v", gotBody)
	}
}

// TestAuth_MFAVerifyOTP_SendsMethodOTP asserts MFAVerifyOTP routes
// through /auth/mfa/verify with method=otp_internal (proposal §3.2.2).
func TestAuth_MFAVerifyOTP_SendsMethodOTP(t *testing.T) {
	var gotBody map[string]any
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/mfa/verify": func(w http.ResponseWriter, r *http.Request) {
			buf, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(buf, &gotBody)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "atok2", "refresh_token": "rtok2", "expires_in": 900,
				"tenants": []any{},
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	if _, err := r.Auth.MFAVerifyOTP(context.Background(), MFAVerifyOTPRequest{
		MFAToken:  "ch-9",
		Presented: "654321",
	}); err != nil {
		t.Fatalf("MFAVerifyOTP: %v", err)
	}
	if gotBody["method"] != "otp_internal" {
		t.Errorf("method = %v, want otp_internal", gotBody["method"])
	}
	if gotBody["code"] != "654321" {
		t.Errorf("code = %v", gotBody["code"])
	}
}
