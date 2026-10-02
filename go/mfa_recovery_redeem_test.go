package realmid

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// --- AuthClient.RedeemRecoveryCode (SPEC §4.3a) ---

func TestRedeemRecoveryCode_RequestAndResponse(t *testing.T) {
	var body map[string]any
	var auth, ip string
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/mfa/recovery": func(w http.ResponseWriter, r *http.Request) {
			buf, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(buf, &body)
			auth, ip = r.Header.Get("Authorization"), r.Header.Get("X-On-Behalf-Of-IP")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "atok", "refresh_token": "rtok", "expires_in": 900,
				"reenroll_required": true,
				"tenants":           []any{},
			})
		},
	})
	defer srv.Close()
	r, _ := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	s, err := r.Auth.RedeemRecoveryCode(context.Background(), RedeemRecoveryCodeRequest{
		ChallengeToken: "ch-1", Code: "abcd-efgh", OnBehalfOfIP: "198.51.100.7",
	})
	if err != nil {
		t.Fatalf("redeem: %v", err)
	}
	if body["mfa_challenge_token"] != "ch-1" || body["code"] != "abcd-efgh" {
		t.Errorf("body = %#v", body)
	}
	if !strings.HasPrefix(auth, "Bearer ") || ip != "198.51.100.7" {
		t.Errorf("auth=%q ip=%q", auth, ip)
	}
	if !s.ReenrollRequired || s.AccessToken != "atok" || s.RefreshToken != "rtok" {
		t.Errorf("session = %#v", s)
	}
}

func TestRedeemRecoveryCode_RunsProductRolesMint(t *testing.T) {
	var got map[string]any
	var calls int32
	srv := laneThenTokenServer(t, "/auth/mfa/recovery", &got, &calls)
	defer srv.Close()
	var sawTenant, sawUser string
	r, _ := NewRealm(Config{SessionStore: NewMemorySessionStore(),
		RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
		ProductRoles: func(_ context.Context, tenantID, userID string) ([]string, error) {
			sawTenant, sawUser = tenantID, userID
			return []string{"dispatch"}, nil
		},
	})
	if _, err := r.Auth.RedeemRecoveryCode(context.Background(), RedeemRecoveryCodeRequest{
		ChallengeToken: "mfa", Code: "abcd-efgh",
	}); err != nil {
		t.Fatalf("redeem: %v", err)
	}
	if calls != 1 || sawTenant != "t1" || sawUser != "u1" {
		t.Fatalf("calls=%d handler=(%q,%q)", calls, sawTenant, sawUser)
	}
	roles, _ := got["product_roles"].([]any)
	if len(roles) != 1 || roles[0] != "dispatch" {
		t.Errorf("product_roles = %#v", got["product_roles"])
	}
}

func TestRedeemRecoveryCode_ErrorMapping(t *testing.T) {
	for _, c := range []struct {
		status int
		code   string
	}{{401, "unauthorized"}, {429, "rate_limited"}} {
		srv := authTestServer(t, map[string]http.HandlerFunc{
			"/auth/mfa/recovery": func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(c.status)
				_, _ = w.Write([]byte(`{"error":{"code":"` + c.code + `","message":"x","details":{"server_code":"mfa_too_many_fails"}}}`))
			},
		})
		r, _ := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
		_, err := r.Auth.RedeemRecoveryCode(context.Background(), RedeemRecoveryCodeRequest{ChallengeToken: "c", Code: "x"})
		var re *RealmError
		if !errors.As(err, &re) || re.HTTPStatus != c.status || string(re.Code) != c.code {
			t.Errorf("status %d: err = %#v", c.status, err)
		}
		srv.Close()
	}
}

func TestAuthFlowMFARecoveryIsDistinct(t *testing.T) {
	for _, f := range []AuthFlow{FlowLogin, FlowRefresh, FlowMFAVerify, FlowOTP, FlowPassword, FlowTenantChoice} {
		if f == FlowMFARecovery {
			t.Fatalf("FlowMFARecovery collides with %d", f)
		}
	}
}

// --- middleware route (SPEC §10.1 step 5a) ---

const recBody = `{"challenge_token":"c","code":"abcd-efgh"}`

func (e *rfEnv) recoveryCalls() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.recCalls
}

func TestMiddlewareRecovery_TakesTheRefreshLockAndStoresOutcome(t *testing.T) {
	e := newRFEnv(t, rfOpts{opts: MiddlewareOptions{RecoveryPath: "/mfa/recovery"}})
	ok, rel, _ := e.store.AcquireRefreshLock(context.Background(), refreshLockKey("rt-old"), time.Hour)
	if !ok {
		t.Fatal("setup")
	}
	done := make(chan int, 1)
	go func() { done <- e.post("/mfa/recovery", "rt-old", recBody).Code }()
	time.Sleep(200 * time.Millisecond)
	if e.recoveryCalls() != 0 {
		t.Fatal("must wait for the lock before calling the issuer")
	}
	_ = rel(context.Background())
	if code := <-done; code != 200 || e.recoveryCalls() != 1 {
		t.Fatalf("code=%d calls=%d", code, e.recoveryCalls())
	}
	if _, ok, _ := e.store.GetRefreshResult(context.Background(), refreshOutcomeKey("rt-old")); !ok {
		t.Fatal("recovery must store its outcome")
	}
}

func TestMiddlewareRecovery_BodyCarriesReenrollRequired(t *testing.T) {
	e := newRFEnv(t, rfOpts{opts: MiddlewareOptions{RecoveryPath: "/mfa/recovery"}})
	w := e.post("/mfa/recovery", "", recBody)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"reenroll_required":true`) {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}

func TestMiddlewareRecovery_FiresSuccessWithFlowMFARecovery(t *testing.T) {
	var flow atomic.Int32
	flow.Store(-1)
	e := newRFEnv(t, rfOpts{opts: MiddlewareOptions{
		RecoveryPath: "/mfa/recovery",
		OnAuthSuccess: func(_ context.Context, ev *AuthSuccessEvent) error {
			flow.Store(int32(ev.Flow))
			return nil
		},
	}})
	e.post("/mfa/recovery", "", recBody)
	if AuthFlow(flow.Load()) != FlowMFARecovery {
		t.Fatalf("flow = %d, want FlowMFARecovery", flow.Load())
	}
}

func TestMiddlewareRecovery_WaitingTooLongIs503AndIssuerNotCalled(t *testing.T) {
	e := newRFEnv(t, rfOpts{opts: MiddlewareOptions{RecoveryPath: "/mfa/recovery"}})
	e.realm.refreshSleep = func(time.Duration) {}
	_, _, _ = e.store.AcquireRefreshLock(context.Background(), refreshLockKey("rt-old"), time.Hour)
	w := e.post("/mfa/recovery", "rt-old", recBody)
	if w.Code != 503 || e.recoveryCalls() != 0 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}

func TestMiddlewareRecovery_PathCanBeRenamed(t *testing.T) {
	e := newRFEnv(t, rfOpts{opts: MiddlewareOptions{RecoveryPath: "/x/recover"}})
	if w := e.post("/x/recover", "", recBody); w.Code != 200 {
		t.Fatalf("renamed: %d %s", w.Code, w.Body.String())
	}
}

// Owner ruling 2026-10-02: the recovery route is OFF unless RecoveryPath is set.
func TestMiddlewareRecovery_UnsetPathServesNothing(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	w := e.post("/mfa/recovery", "", recBody)
	if e.recoveryCalls() != 0 {
		t.Fatalf("recovery handler ran with RecoveryPath unset: %d %s", w.Code, w.Body.String())
	}
	if w.Code == 200 && strings.Contains(w.Body.String(), "reenroll_required") {
		t.Fatalf("recovery body served with RecoveryPath unset: %s", w.Body.String())
	}
}

// An empty RecoveryPath must not match any request path (including the bare prefix).
func TestMiddlewareRecovery_UnsetPathMatchesNoPath(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	for _, p := range []string{"/", "/recovery", "/mfa"} {
		e.post(p, "", recBody)
	}
	if e.recoveryCalls() != 0 {
		t.Fatalf("recovery handler ran %d times with RecoveryPath unset", e.recoveryCalls())
	}
}
