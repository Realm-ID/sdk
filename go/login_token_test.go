package realmid

import (
	"context"
	"net/http"
	"testing"
)

// SPEC14_1_login_token (R44, R62, R71): login authenticates; /auth/token mints. The fake login
// answers WITH a stray access_token to prove the SDK never reads it.

func loginFake(t *testing.T, tenants []any) *fakeIssuer {
	f := newFakeIssuer(t)
	f.on("/auth/login", func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		jsonReply(w, 200, map[string]any{"access_token": "LEAKED-FROM-LOGIN", "refresh_token": "rt1",
			"expires_in": 900, "user": map[string]any{"id": "u1"}, "tenants": tenants})
	})
	f.on("/auth/token", func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		jsonReply(w, 200, map[string]any{"access_token": "MINTED-AT", "refresh_token": "rt2", "expires_in": 600, "tenant_id": "t1", "role": "member"})
	})
	return f
}

func TestLoginToken_SingleTenantMintsAtAuthTokenAndIgnoresLoginAccessToken(t *testing.T) {
	f := loginFake(t, []any{map[string]any{"tenant_id": "t1", "role": "member"}})
	s, err := f.realm(t, nil).Auth.Login(context.Background(), LoginRequest{Method: LoginGoogle, ProviderToken: "pt"})
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if s.AccessToken != "MINTED-AT" {
		t.Errorf("AccessToken = %q; want the /auth/token mint, never login's access_token", s.AccessToken)
	}
	var mints int
	for _, r := range f.reqs("/auth/token") {
		if r.Body["grant_type"] != "platform_api_key" {
			mints++
			if r.Body["refresh_token"] != "rt1" || r.Body["tenant_id"] != "t1" || r.Auth != "Bearer ptok" {
				t.Errorf("mint request wrong: %+v", r)
			}
		}
	}
	if mints != 1 {
		t.Errorf("user mints at /auth/token = %d, want exactly 1 (auto-mint on exactly one tenant, R44)", mints)
	}
}

func TestLoginToken_MultiTenantDoesNotMintAndDropsLoginAccessToken(t *testing.T) {
	f := loginFake(t, []any{map[string]any{"tenant_id": "t1"}, map[string]any{"tenant_id": "t2"}})
	r := f.realm(t, nil)
	s, err := r.Auth.Login(context.Background(), LoginRequest{Method: LoginGoogle, ProviderToken: "pt"})
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if s.AccessToken != "" {
		t.Errorf("AccessToken = %q before tenant choice; the SDK must never surface login's access_token", s.AccessToken)
	}
	if !s.NeedsTenantChoice() {
		t.Error("NeedsTenantChoice = false")
	}
	if err := r.Auth.CompleteLogin(context.Background(), s, "t2", nil); err != nil {
		t.Fatalf("CompleteLogin: %v", err)
	}
	if s.AccessToken != "MINTED-AT" {
		t.Errorf("after choice AccessToken = %q, want the mint", s.AccessToken)
	}
}

func TestLoginToken_MFAVerifyExchangesAtAuthTokenToo(t *testing.T) {
	f := loginFake(t, nil)
	f.on("/auth/mfa/verify", func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		jsonReply(w, 200, map[string]any{"access_token": "LEAKED-FROM-VERIFY", "refresh_token": "rt1", "expires_in": 900,
			"tenants": []any{map[string]any{"tenant_id": "t1", "role": "member"}}})
	})
	s, err := f.realm(t, nil).Auth.MFAVerify(context.Background(), MFAVerifyRequest{ChallengeToken: "ct", Code: "123456"})
	if err != nil {
		t.Fatalf("MFAVerify: %v", err)
	}
	if s.AccessToken != "MINTED-AT" {
		t.Errorf("AccessToken = %q; MFA verify must exchange at /auth/token (R51)", s.AccessToken)
	}
}

func TestLoginToken_PlatformMintOnAuthTokenOnlyNoLoginFallback(t *testing.T) {
	f := newFakeIssuer(t)
	f.on("/tenants/t1", func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		jsonReply(w, 200, map[string]any{"id": "t1"})
	})
	if _, err := f.realm(t, nil).Tenants.Get(context.Background(), "t1"); err != nil {
		t.Fatalf("Tenants.Get: %v", err)
	}
	if n := len(f.reqs("/auth/login")); n != 0 {
		t.Errorf("platform_api_key was sent to /auth/login %d times; want 0", n)
	}
	pm := f.reqs("/auth/token")
	if len(pm) != 1 || pm[0].Body["grant_type"] != "platform_api_key" || pm[0].Body["api_key"] != "rk" {
		t.Errorf("platform mint at /auth/token wrong: %+v", pm)
	}
}

func TestLoginToken_NoFallbackToLoginWhenTokenEndpointFails(t *testing.T) {
	f := newFakeIssuer(t)
	f.on("/auth/token", nil) // placeholder so the route exists below
	delete(f.handlers, "/auth/token")
	f.srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/auth/token" {
			f.mu.Lock()
			f.seen = append(f.seen, seenReq{Method: r.Method, Path: r.URL.Path})
			f.mu.Unlock()
			jsonReply(w, 404, map[string]any{"error": map[string]any{"code": "not_found", "message": "old issuer"}})
			return
		}
		f.serve(w, r)
	})
	_, err := f.realm(t, nil).Tenants.Get(context.Background(), "t1")
	if err == nil {
		t.Fatal("expected an error from an issuer without /auth/token platform mint")
	}
	if n := len(f.reqs("/auth/login")); n != 0 {
		t.Errorf("fell back to /auth/login %d times; R71 forbids any fallback", n)
	}
}
