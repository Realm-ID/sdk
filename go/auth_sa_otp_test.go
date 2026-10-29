package realmid

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"testing"
)

// TestAuth_ServiceAccountOTPLogin_OneCallToToken pins owner ruling Q3 (2026-10-29): a bot pairs by OTP
// in ONE call to /auth/token (never /auth/login), tenant_id on the wire, and gets both tokens.
func TestAuth_ServiceAccountOTPLogin_OneCallToToken(t *testing.T) {
	var gotBody map[string]any
	calls := map[string]int{}
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/token": platformMintThen(func(w http.ResponseWriter, r *http.Request) {
			calls["/auth/token"]++
			buf, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(buf, &gotBody)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "atok", "refresh_token": "rtok", "expires_in": 900,
				"subject_type": "service", "tenant_id": "t1", "role": "member",
			})
		}),
		"/auth/login": func(w http.ResponseWriter, r *http.Request) {
			calls["/auth/login"]++
			http.Error(w, "bots must not use /auth/login", http.StatusTeapot)
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.Auth.ServiceAccountOTPLogin(context.Background(), ServiceAccountOTPLoginRequest{
		Identifier: "bot@example.com", Presented: "123456", TenantID: "t1",
	})
	if err != nil {
		t.Fatalf("ServiceAccountOTPLogin: %v", err)
	}
	if out.AccessToken != "atok" || out.RefreshToken != "rtok" {
		t.Errorf("tokens = %q / %q", out.AccessToken, out.RefreshToken)
	}
	if calls["/auth/token"] != 1 || calls["/auth/login"] != 0 {
		t.Errorf("calls = %v, want exactly one /auth/token and no /auth/login", calls)
	}
	if gotBody["grant_type"] != "otp" || gotBody["tenant_id"] != "t1" ||
		gotBody["identifier"] != "bot@example.com" || gotBody["presented"] != "123456" {
		t.Errorf("body = %+v", gotBody)
	}
}

func TestAuth_ServiceAccountOTPLogin_RequiresTenant(t *testing.T) {
	hit := false
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/token": platformMintThen(func(w http.ResponseWriter, _ *http.Request) { hit = true }),
	})
	defer srv.Close()
	r, _ := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	_, err := r.Auth.ServiceAccountOTPLogin(context.Background(), ServiceAccountOTPLoginRequest{Identifier: "b", Presented: "1"})
	var re *RealmError
	if !errors.As(err, &re) || re.Details["server_code"] != "missing_tenant_id" {
		t.Fatalf("err = %v, want RealmError server_code missing_tenant_id", err)
	}
	if hit {
		t.Error("request left the client without a tenant_id")
	}
}
