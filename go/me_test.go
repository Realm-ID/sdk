package realmid

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// meServer wires the platform-token bootstrap plus the caller's handlers.
func meServer(t *testing.T, handlers map[string]http.HandlerFunc) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	for p, h := range handlers {
		mux.HandleFunc(p, h)
	}
	return httptest.NewServer(mux)
}

func TestMe_ChooseTenantSendsKeptTenantAndDecodesReleased(t *testing.T) {
	var gotBody map[string]any
	var gotAuth string
	srv := meServer(t, map[string]http.HandlerFunc{
		"/me/tenant-choice": func(w http.ResponseWriter, r *http.Request) {
			if r.Method != "POST" {
				t.Errorf("method=%s", r.Method)
			}
			gotAuth = r.Header.Get("Authorization")
			buf, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(buf, &gotBody)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"tenant_id": "t-keep", "status": "chosen", "released": 2,
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.Me.ChooseTenant(context.Background(), TenantChoiceRequest{
		MeAuth:   MeAuth{UserBearer: "user-jwt"},
		TenantID: "t-keep",
	})
	if err != nil {
		t.Fatalf("choose: %v", err)
	}
	// The body names the membership to KEEP, not the ones released.
	if gotBody["tenant_id"] != "t-keep" {
		t.Errorf("body tenant_id=%#v", gotBody["tenant_id"])
	}
	if gotAuth != "Bearer user-jwt" {
		t.Errorf("authorization=%q, want the user bearer in direct mode", gotAuth)
	}
	if out.Status != "chosen" || out.Released != 2 || out.TenantID != "t-keep" {
		t.Errorf("result=%+v", out)
	}
}

func TestMe_BFFModeSendsUserTokenBesidePlatformBearer(t *testing.T) {
	var gotAuth, gotUserToken string
	srv := meServer(t, map[string]http.HandlerFunc{
		"/me/tenant-choice": func(w http.ResponseWriter, r *http.Request) {
			gotAuth = r.Header.Get("Authorization")
			gotUserToken = r.Header.Get("X-User-Token")
			_ = json.NewEncoder(w).Encode(map[string]any{"tenant_id": "t1", "status": "chosen"})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	if _, err := r.Me.ChooseTenant(context.Background(), TenantChoiceRequest{
		MeAuth:   MeAuth{UserToken: "verified-jwt"},
		TenantID: "t1",
	}); err != nil {
		t.Fatalf("choose: %v", err)
	}
	// The platform token stays the bearer; the user JWT is additive. A BARE
	// user id is not an identity (issuer v0.66.0), so the verified token is
	// the only thing that names the caller.
	if gotAuth != "Bearer ptok" {
		t.Errorf("authorization=%q, want the platform token", gotAuth)
	}
	if gotUserToken != "verified-jwt" {
		t.Errorf("x-user-token=%q", gotUserToken)
	}
}

func TestMe_CtxUserTokenIsUsedWhenNoneOnTheRequest(t *testing.T) {
	var gotUserToken string
	srv := meServer(t, map[string]http.HandlerFunc{
		"/me/memberships/t1/leave": func(w http.ResponseWriter, r *http.Request) {
			gotUserToken = r.Header.Get("X-User-Token")
			_ = json.NewEncoder(w).Encode(map[string]any{"tenant_id": "t1", "status": "left"})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	ctx := WithUserToken(context.Background(), "ctx-jwt")
	if _, err := r.Me.LeaveMembership(ctx, MembershipRequest{TenantID: "t1"}); err != nil {
		t.Fatalf("leave: %v", err)
	}
	if gotUserToken != "ctx-jwt" {
		t.Errorf("x-user-token=%q, want the ctx-stashed token", gotUserToken)
	}
}

func TestMe_RejectAndLeaveHitTheirOwnRoutes(t *testing.T) {
	hit := map[string]bool{}
	srv := meServer(t, map[string]http.HandlerFunc{
		"/me/invitations/t%20one/reject": func(w http.ResponseWriter, r *http.Request) {
			hit["reject"] = true
			// No request body — the path and the session say everything.
			buf, _ := io.ReadAll(r.Body)
			if len(buf) != 0 {
				t.Errorf("reject body=%q, want empty", buf)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"tenant_id": "t one", "status": "rejected"})
		},
		"/me/memberships/t1/leave": func(w http.ResponseWriter, _ *http.Request) {
			hit["leave"] = true
			_ = json.NewEncoder(w).Encode(map[string]any{"tenant_id": "t1", "status": "left"})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	// A tenant id is a path SEGMENT and must be escaped, not interpolated raw.
	rej, err := r.Me.RejectInvitation(context.Background(), MembershipRequest{
		MeAuth: MeAuth{UserBearer: "u"}, TenantID: "t one",
	})
	if err != nil {
		t.Fatalf("reject: %v", err)
	}
	if rej.Status != "rejected" {
		t.Errorf("reject status=%q", rej.Status)
	}
	left, err := r.Me.LeaveMembership(context.Background(), MembershipRequest{
		MeAuth: MeAuth{UserBearer: "u"}, TenantID: "t1",
	})
	if err != nil {
		t.Fatalf("leave: %v", err)
	}
	if left.Status != "left" {
		t.Errorf("leave status=%q", left.Status)
	}
	if !hit["reject"] || !hit["leave"] {
		t.Errorf("routes hit=%v", hit)
	}
}

func TestMe_OwnerCannotBeRevokedSurfacesAsRealmError(t *testing.T) {
	srv := meServer(t, map[string]http.HandlerFunc{
		"/me/tenant-choice": func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": map[string]any{
					"code":    "owner_cannot_be_revoked",
					"message": "transfer ownership first",
				},
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	_, err := r.Me.ChooseTenant(context.Background(), TenantChoiceRequest{
		MeAuth: MeAuth{UserBearer: "u"}, TenantID: "t1",
	})
	if err == nil {
		t.Fatal("want an error")
	}
	re, ok := err.(*RealmError)
	if !ok {
		t.Fatalf("err type %T", err)
	}
	if re.Code != "owner_cannot_be_revoked" {
		t.Errorf("code=%q", re.Code)
	}
}

func TestAuth_LoginDecodesTenantChoicePicker(t *testing.T) {
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/login": func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				// The login SUCCEEDS: the picker rides alongside real tokens.
				"access_token":  "atok",
				"refresh_token": "rtok",
				"expires_in":    900,
				"user":          map[string]any{"id": "u1"},
				"tenants":       []any{},

				"tenant_choice_required": true,
				"tenant_choices": []any{
					map[string]any{"tenant_id": "t1", "display_name": "Acme", "is_owner": false},
					map[string]any{"tenant_id": "t2", "display_name": "Mine", "is_owner": true},
				},
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	s, err := r.Auth.Login(context.Background(), LoginRequest{Method: LoginGoogle, ProviderToken: "tok"})
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if s.AccessToken != "atok" {
		t.Errorf("access_token=%q — the picker is a prompt, not an auth failure", s.AccessToken)
	}
	if !s.TenantChoiceRequired {
		t.Error("TenantChoiceRequired=false")
	}
	if len(s.TenantChoices) != 2 {
		t.Fatalf("choices=%d", len(s.TenantChoices))
	}
	if s.TenantChoices[0].TenantID != "t1" || s.TenantChoices[0].DisplayName != "Acme" || s.TenantChoices[0].IsOwner {
		t.Errorf("choice[0]=%+v", s.TenantChoices[0])
	}
	// An owned membership cannot be given up — the client must not offer it.
	if !s.TenantChoices[1].IsOwner {
		t.Errorf("choice[1]=%+v, want is_owner", s.TenantChoices[1])
	}
}

func TestAuth_LoginWithoutPickerLeavesTheFieldsZero(t *testing.T) {
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/login": func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "atok", "refresh_token": "rtok", "expires_in": 900,
				"user": map[string]any{"id": "u1"}, "tenants": []any{},
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	s, err := r.Auth.Login(context.Background(), LoginRequest{Method: LoginGoogle, ProviderToken: "tok"})
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if s.TenantChoiceRequired || s.TenantChoices != nil {
		t.Errorf("picker leaked into an ordinary login: %+v / %+v", s.TenantChoiceRequired, s.TenantChoices)
	}
}

func TestConfig_GetSurfacesPendingReconciliationBesideConfig(t *testing.T) {
	srv := meServer(t, map[string]http.HandlerFunc{
		"/platforms/" + testRealmID + "/config": func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":     testRealmID,
				"config": map[string]any{"single_tenant_membership": true},
				// Derived, read-only, and deliberately OUTSIDE config.
				"single_tenant_pending_reconciliation": 3,
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.Config.Get(context.Background())
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if out.Config["single_tenant_membership"] != true {
		t.Errorf("single_tenant_membership=%#v", out.Config["single_tenant_membership"])
	}
	if _, leaked := out.Config["single_tenant_pending_reconciliation"]; leaked {
		t.Error("the derived count must not appear inside the settable config bag")
	}
	if out.SingleTenantPendingReconciliation == nil {
		t.Fatal("SingleTenantPendingReconciliation=nil, want 3")
	}
	if *out.SingleTenantPendingReconciliation != 3 {
		t.Errorf("pending=%d", *out.SingleTenantPendingReconciliation)
	}
}

func TestConfig_PendingReconciliationIsNilWhenTheRuleIsOff(t *testing.T) {
	srv := meServer(t, map[string]http.HandlerFunc{
		"/platforms/" + testRealmID + "/config": func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":     testRealmID,
				"config": map[string]any{"single_tenant_membership": false},
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.Config.Get(context.Background())
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	// nil, not 0: "not reported" and "reported as fully drained" are different
	// facts and a caller rendering the number must be able to tell them apart.
	if out.SingleTenantPendingReconciliation != nil {
		t.Errorf("pending=%v, want nil", *out.SingleTenantPendingReconciliation)
	}
}
