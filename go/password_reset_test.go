package realmid

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// ADR-111 / SPEC §4.1.8, §4.10, §6.3 (go 0.65.0).

func decodeBody(t *testing.T, r *http.Request) map[string]any {
	t.Helper()
	buf, _ := io.ReadAll(r.Body)
	var m map[string]any
	_ = json.Unmarshal(buf, &m)
	return m
}

func newPWRealm(t *testing.T, url string) *Realm {
	t.Helper()
	r, err := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: url})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestPasswordLogin_NewPasswordOnWireOnlyWhenSet(t *testing.T) {
	var got map[string]any
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/login": func(w http.ResponseWriter, r *http.Request) {
			got = decodeBody(t, r)
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "a", "refresh_token": "r", "user": map[string]any{"id": "u"}})
		},
	})
	defer srv.Close()
	r := newPWRealm(t, srv.URL)

	if _, err := r.Auth.PasswordLogin(context.Background(), PasswordLoginRequest{Identifier: "a@b.c", Presented: "old", NewPassword: "brand-new-pass-1"}); err != nil {
		t.Fatal(err)
	}
	if got["new_password"] != "brand-new-pass-1" || got["presented"] != "old" {
		t.Errorf("body = %v", got)
	}
	if _, err := r.Auth.PasswordLogin(context.Background(), PasswordLoginRequest{Identifier: "a@b.c", Presented: "old"}); err != nil {
		t.Fatal(err)
	}
	if _, present := got["new_password"]; present {
		t.Errorf("empty NewPassword must be omitted, body = %v", got)
	}
}

func TestInspectPasswordReset(t *testing.T) {
	var got map[string]any
	var auth string
	srv := meServer(t, map[string]http.HandlerFunc{
		"/auth/password/reset/inspect": func(w http.ResponseWriter, r *http.Request) {
			got = decodeBody(t, r)
			auth = r.Header.Get("Authorization")
			if r.URL.RawQuery != "" {
				t.Errorf("token must not be in the query: %q", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"expires_at":"2026-10-09T12:30:00Z"}`))
		},
	})
	defer srv.Close()
	r := newPWRealm(t, srv.URL)
	out, err := r.Auth.InspectPasswordReset(context.Background(), "tok43")
	if err != nil {
		t.Fatal(err)
	}
	if got["token"] != "tok43" || len(got) != 1 {
		t.Errorf("body = %v, want only token", got)
	}
	if !strings.HasPrefix(auth, "Bearer ") {
		t.Errorf("platform bearer not sent: %q", auth)
	}
	if !out.ExpiresAt.Equal(time.Date(2026, 10, 9, 12, 30, 0, 0, time.UTC)) {
		t.Errorf("ExpiresAt = %v", out.ExpiresAt)
	}
}

func TestConsumePasswordReset_Body(t *testing.T) {
	var got map[string]any
	srv := meServer(t, map[string]http.HandlerFunc{
		"/auth/password/reset": func(w http.ResponseWriter, r *http.Request) {
			got = decodeBody(t, r)
			_, _ = w.Write([]byte(`{"status":"password_set"}`))
		},
	})
	defer srv.Close()
	r := newPWRealm(t, srv.URL)
	if _, err := r.Auth.ConsumePasswordReset(context.Background(), "tok43", "a-long-new-password"); err != nil {
		t.Fatal(err)
	}
	if got["token"] != "tok43" || got["new_password"] != "a-long-new-password" {
		t.Errorf("body = %v", got)
	}
}

func TestConsumePasswordReset_ErrorsAreTypedAndNotRetried(t *testing.T) {
	cases := []struct {
		status int
		code   ErrorCode
	}{
		{400, ErrCodeResetTokenInvalid},
		{410, ErrCodeResetTokenExpired},
		{410, ErrCodeResetTokenUsed},
		{410, ErrCodeResetTokenSuperseded},
	}
	for _, c := range cases {
		var calls int32
		srv := meServer(t, map[string]http.HandlerFunc{
			"/auth/password/reset": func(w http.ResponseWriter, _ *http.Request) {
				atomic.AddInt32(&calls, 1)
				w.WriteHeader(c.status)
				_, _ = w.Write([]byte(`{"error":{"code":"` + string(c.code) + `","message":"m"}}`))
			},
		})
		r := newPWRealm(t, srv.URL)
		_, err := r.Auth.ConsumePasswordReset(context.Background(), "t", "pw-long-enough-12")
		if !IsCode(err, c.code) {
			t.Errorf("%d %s: err = %v", c.status, c.code, err)
		}
		if n := atomic.LoadInt32(&calls); n != 1 {
			t.Errorf("%s: %d calls, want 1", c.code, n)
		}
		srv.Close()
	}
}

func TestSendPasswordReset(t *testing.T) {
	var method, path string
	var bodyLen int
	srv := meServer(t, map[string]http.HandlerFunc{
		"/tenants/t1/users/u1/password-reset": func(w http.ResponseWriter, r *http.Request) {
			method, path = r.Method, r.URL.Path
			b, _ := io.ReadAll(r.Body)
			bodyLen = len(b)
			w.WriteHeader(202)
			_, _ = w.Write([]byte(`{"status":"sent","to":"a***@example.com","expires_at":"2026-10-09T12:30:00Z"}`))
		},
	})
	defer srv.Close()
	r := newPWRealm(t, srv.URL)
	out, err := r.Tenants.Users.SendPasswordReset(context.Background(), "t1", "u1")
	if err != nil {
		t.Fatal(err)
	}
	if method != "POST" || path != "/tenants/t1/users/u1/password-reset" || bodyLen != 0 {
		t.Errorf("%s %s body=%d", method, path, bodyLen)
	}
	if out.Status != "sent" || out.To != "a***@example.com" || out.ExpiresAt.IsZero() {
		t.Errorf("out = %+v", out)
	}
}

func TestSendPasswordReset_TypedErrors(t *testing.T) {
	for _, c := range []struct {
		status int
		code   ErrorCode
	}{{409, ErrCodeNoVerifiedEmail}, {429, ErrCodeResetThrottled}} {
		srv := meServer(t, map[string]http.HandlerFunc{
			"/tenants/t1/users/u1/password-reset": func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(c.status)
				_, _ = w.Write([]byte(`{"error":{"code":"` + string(c.code) + `","message":"m"}}`))
			},
		})
		r := newPWRealm(t, srv.URL)
		_, err := r.Tenants.Users.SendPasswordReset(context.Background(), "t1", "u1")
		if !IsCode(err, c.code) {
			t.Errorf("%s: err = %v", c.code, err)
		}
		srv.Close()
	}
}

func TestSetCredentials(t *testing.T) {
	var method string
	var got map[string]any
	srv := meServer(t, map[string]http.HandlerFunc{
		"/tenants/t1/users/u1/credentials": func(w http.ResponseWriter, r *http.Request) {
			method = r.Method
			got = decodeBody(t, r)
			w.WriteHeader(204)
		},
	})
	defer srv.Close()
	r := newPWRealm(t, srv.URL)
	if err := r.Tenants.Users.SetCredentials(context.Background(), "t1", "u1", SetCredentialsRequest{Username: "bob"}); err != nil {
		t.Fatal(err)
	}
	if method != "PUT" || got["username"] != "bob" {
		t.Errorf("%s %v", method, got)
	}
	if _, ok := got["password"]; ok {
		t.Errorf("empty password must not be sent: %v", got)
	}
	if err := r.Tenants.Users.SetCredentials(context.Background(), "t1", "u1", SetCredentialsRequest{Password: "temp-pass-12345"}); err != nil {
		t.Fatal(err)
	}
	if _, ok := got["username"]; ok || got["password"] != "temp-pass-12345" {
		t.Errorf("body = %v", got)
	}
}

func TestSetCredentials_TypedErrors(t *testing.T) {
	for _, code := range []ErrorCode{ErrCodeResetLinkRequired, ErrCodeVerifiedEmailRequired} {
		srv := meServer(t, map[string]http.HandlerFunc{
			"/tenants/t1/users/u1/credentials": func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(409)
				_, _ = w.Write([]byte(`{"error":{"code":"` + string(code) + `","message":"m"}}`))
			},
		})
		r := newPWRealm(t, srv.URL)
		err := r.Tenants.Users.SetCredentials(context.Background(), "t1", "u1", SetCredentialsRequest{Password: "x"})
		if !IsCode(err, code) {
			t.Errorf("%s: err = %v", code, err)
		}
		srv.Close()
	}
}

func TestPasswordLogin_ChangeCodesTyped(t *testing.T) {
	for _, code := range []ErrorCode{ErrCodePasswordUnchanged, ErrCodePasswordChangeNotRequired} {
		srv := authTestServer(t, map[string]http.HandlerFunc{
			"/auth/login": func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(400)
				_, _ = w.Write([]byte(`{"error":{"code":"` + string(code) + `","message":"m"}}`))
			},
		})
		r := newPWRealm(t, srv.URL)
		_, err := r.Auth.PasswordLogin(context.Background(), PasswordLoginRequest{Identifier: "i", Presented: "p", NewPassword: "n"})
		if !IsCode(err, code) {
			t.Errorf("%s: err = %v", code, err)
		}
		srv.Close()
	}
}

func TestPasswordPolicy_DiscoveryPointer(t *testing.T) {
	var with, without IdentityProvidersResponse
	if err := json.Unmarshal([]byte(`{"providers":[],"credential_methods":["password"],"password_policy":{"require_verified_email":false}}`), &with); err != nil {
		t.Fatal(err)
	}
	if with.PasswordPolicy == nil || with.PasswordPolicy.RequireVerifiedEmail {
		t.Errorf("explicit false must decode to non-nil false: %+v", with.PasswordPolicy)
	}
	if err := json.Unmarshal([]byte(`{"providers":[]}`), &without); err != nil {
		t.Fatal(err)
	}
	if without.PasswordPolicy != nil {
		t.Errorf("absent must be nil")
	}
	out, _ := json.Marshal(without)
	if strings.Contains(string(out), "password_policy") {
		t.Errorf("nil policy re-serialised: %s", out)
	}
	out, _ = json.Marshal(with)
	if !strings.Contains(string(out), `"require_verified_email":false`) {
		t.Errorf("false lost on re-serialise: %s", out)
	}
}
