package realmid

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestRealm_Do_AttachesPlatformTokenAndOBO(t *testing.T) {
	var (
		gotAuth   string
		gotOBO    string
		gotIP     string
		gotMethod string
		gotPath   string
		gotBody   string
		gotIdem   string
	)
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/tenants/t1/users": func(w http.ResponseWriter, r *http.Request) {
			gotAuth = r.Header.Get("Authorization")
			gotOBO = r.Header.Get("X-On-Behalf-Of-User")
			gotIP = r.Header.Get("X-On-Behalf-Of-IP")
			gotIdem = r.Header.Get("Idempotency-Key")
			gotMethod = r.Method
			gotPath = r.URL.Path
			b, _ := io.ReadAll(r.Body)
			gotBody = string(b)
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"id":"u9"}`))
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})

	resp, err := r.Do(
		context.Background(), http.MethodPost, "/tenants/t1/users",
		strings.NewReader(`{"email":"a@b"}`),
		&PassthroughOptions{
			OnBehalfOfUser: "u-123",
			OnBehalfOfIP:   "203.0.113.7",
			Header:         http.Header{"Idempotency-Key": []string{"abc"}, "Content-Type": []string{"application/json"}},
		},
	)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		t.Errorf("status = %d, want 201", resp.StatusCode)
	}
	if gotAuth != "Bearer ptok" {
		t.Errorf("auth = %q, want Bearer ptok", gotAuth)
	}
	if gotOBO != "u-123" {
		t.Errorf("OBO user = %q", gotOBO)
	}
	if gotIP != "203.0.113.7" {
		t.Errorf("OBO ip = %q", gotIP)
	}
	if gotIdem != "abc" {
		t.Errorf("Idempotency-Key not forwarded: %q", gotIdem)
	}
	if gotMethod != http.MethodPost || gotPath != "/tenants/t1/users" {
		t.Errorf("got %s %s", gotMethod, gotPath)
	}
	if gotBody != `{"email":"a@b"}` {
		t.Errorf("body = %q", gotBody)
	}
}

func TestRealm_Do_UserBearerOverride(t *testing.T) {
	var gotAuth string
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/sessions/abc": func(w http.ResponseWriter, r *http.Request) {
			gotAuth = r.Header.Get("Authorization")
			w.WriteHeader(http.StatusNoContent)
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	resp, err := r.Do(context.Background(), http.MethodDelete, "/auth/sessions/abc", nil, &PassthroughOptions{
		UserBearer: "rt-one-shot-revocation",
	})
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	resp.Body.Close()
	if gotAuth != "Bearer rt-one-shot-revocation" {
		t.Errorf("auth = %q, want UserBearer override", gotAuth)
	}
}

func TestRealm_Do_ForwardsUserTokenAdditive(t *testing.T) {
	// ADR-056: X-User-Token rides ALONGSIDE the platform bearer (additive),
	// unlike UserBearer which replaces it. Cover both the explicit option and
	// the WithUserToken(ctx) fallback, and assert the bearer stays platform.
	cases := []struct {
		name string
		call func(r *Realm) (*http.Response, error)
	}{
		{
			name: "via_option",
			call: func(r *Realm) (*http.Response, error) {
				return r.Do(context.Background(), http.MethodGet, "/tenants/t1", nil,
					&PassthroughOptions{OnBehalfOfUserToken: "user-access-jwt"})
			},
		},
		{
			name: "via_ctx_helper",
			call: func(r *Realm) (*http.Response, error) {
				ctx := WithUserToken(context.Background(), "user-access-jwt")
				return r.Do(ctx, http.MethodGet, "/tenants/t1", nil, nil)
			},
		},
		{
			name: "option_overrides_ctx",
			call: func(r *Realm) (*http.Response, error) {
				ctx := WithUserToken(context.Background(), "ctx-token-ignored")
				return r.Do(ctx, http.MethodGet, "/tenants/t1", nil,
					&PassthroughOptions{OnBehalfOfUserToken: "user-access-jwt"})
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var gotAuth, gotUserTok string
			srv := authTestServer(t, map[string]http.HandlerFunc{
				"/tenants/t1": func(w http.ResponseWriter, r *http.Request) {
					gotAuth = r.Header.Get("Authorization")
					gotUserTok = r.Header.Get("X-User-Token")
					w.WriteHeader(http.StatusOK)
					_, _ = w.Write([]byte(`{"id":"t1"}`))
				},
			})
			defer srv.Close()

			r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
			resp, err := tc.call(r)
			if err != nil {
				t.Fatalf("Do: %v", err)
			}
			resp.Body.Close()
			if gotAuth != "Bearer ptok" {
				t.Errorf("bearer must stay the platform token, got %q", gotAuth)
			}
			if gotUserTok != "user-access-jwt" {
				t.Errorf("X-User-Token = %q, want user-access-jwt", gotUserTok)
			}
		})
	}
}

func TestRealm_Do_Returns4xxResponseUnchanged(t *testing.T) {
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/tenants/missing": func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":{"code":"not_found","message":"nope"}}`))
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	resp, err := r.Do(context.Background(), http.MethodGet, "/tenants/missing", nil, nil)
	if err != nil {
		t.Fatalf("Do should not error on 4xx, got: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404", resp.StatusCode)
	}
}
