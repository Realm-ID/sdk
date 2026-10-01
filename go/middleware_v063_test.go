package realmid

// SPEC §10.1 steps 3, 4b, 6a — logout revokes the session the issuer names,
// the gate runs by default, a ROTATING refresh supersedes older tokens, and
// the bodies carry org_session_mode.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type mwEnv struct {
	srv      *httptest.Server
	realm    *Realm
	sign     signFn
	h        http.Handler
	mu       sync.Mutex
	logout   func() map[string]any // issuer logout response body
	logoutOK bool
	logoutIn []map[string]any // bodies the fake issuer's /auth/logout received
	nextRT   string           // refresh token the fake /auth/token returns
	mintSID  string
	reached  int
}

func newMWEnv(t *testing.T) *mwEnv {
	t.Helper()
	sign, key := mintTestKey(t, "k1")
	e := &mwEnv{sign: sign, logoutOK: true, mintSID: "S1"}
	e.logout = func() map[string]any { return map[string]any{"status": "ok"} }
	e.srv = mwTestServer(t, []jwk{key}, testAud, map[string]http.HandlerFunc{
		"/auth/logout": func(w http.ResponseWriter, r *http.Request) {
			e.mu.Lock()
			defer e.mu.Unlock()
			var in map[string]any
			_ = json.NewDecoder(r.Body).Decode(&in)
			e.logoutIn = append(e.logoutIn, in)
			if !e.logoutOK {
				http.Error(w, "boom", 500)
				return
			}
			_ = json.NewEncoder(w).Encode(e.logout())
		},
		"/auth/token": func(w http.ResponseWriter, _ *http.Request) {
			e.mu.Lock()
			defer e.mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":  e.token(e.mintSID, "sub1", time.Now().Add(10*time.Second)),
				"refresh_token": e.nextRT, "expires_in": 900, "tenant_id": "t1", "role": "member",
			})
		},
		"/" + testRealmID + "/.well-known/openid-configuration": func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"realmid_org_sessions": "exclusive"})
		},
	})
	t.Cleanup(e.srv.Close)
	r, err := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "k", BaseURL: e.srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	e.realm = r
	e.h = r.Middleware(MiddlewareOptions{MFAProtectedPaths: []MFARule{{Method: "GET", Path: "/secure"}}})(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { e.reached++; w.WriteHeader(200) }))
	return e
}

func (e *mwEnv) token(sid, sub string, iat time.Time) string {
	c := baseClaims(e.srv.URL, func(c map[string]any) {
		c["sub"] = sub
		c["iat"] = iat.Unix()
		c["exp"] = iat.Add(time.Hour).Unix()
		if sid != "" {
			c["sid"] = sid
		}
	})
	return e.sign(c)
}

func (e *mwEnv) do(method, path, bearer string, cookie string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(`{"tenant_id":"t1"}`))
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: "realmid_refresh", Value: cookie})
	}
	w := httptest.NewRecorder()
	e.h.ServeHTTP(w, req)
	return w
}

func (e *mwEnv) wantRevoked(t *testing.T, bearer string) {
	t.Helper()
	w := e.do("GET", "/api/x", bearer, "")
	var body struct {
		Revoked bool `json:"revoked"`
		Error   struct{ Code string }
	}
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if w.Code != 401 || !body.Revoked || body.Error.Code != "unauthorized" {
		t.Fatalf("want 401 revoked, got %d %s", w.Code, w.Body.String())
	}
}

func (e *mwEnv) wantPass(t *testing.T, bearer string) {
	t.Helper()
	if w := e.do("GET", "/api/x", bearer, ""); w.Code != 200 {
		t.Fatalf("want 200, got %d %s", w.Code, w.Body.String())
	}
}

func TestSPEC10_1_3_LogoutRevokesTheIssuersSid_NoBearer(t *testing.T) {
	e := newMWEnv(t)
	e.logout = func() map[string]any { return map[string]any{"status": "ok", "sid": "S1"} }
	tokOtherTenant := e.token("S1", "other-membership", time.Now())
	e.wantPass(t, tokOtherTenant)
	w := e.do("POST", "/logout", "", "rt1")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"ok"`) {
		t.Fatalf("logout: %d %s", w.Code, w.Body.String())
	}
	e.wantRevoked(t, tokOtherTenant)
	e.wantPass(t, e.token("S2", "u", time.Now()))
}

func TestSPEC10_1_3_RevokedSidsAllRevoked(t *testing.T) {
	e := newMWEnv(t)
	e.logout = func() map[string]any {
		return map[string]any{"status": "ok", "sid": "S1", "revoked_sids": []string{"S1", "S2", "S3"}}
	}
	e.do("POST", "/logout", "", "rt1")
	for _, s := range []string{"S1", "S2", "S3"} {
		e.wantRevoked(t, e.token(s, "u", time.Now()))
	}
	e.wantPass(t, e.token("S4", "u", time.Now()))
}

func TestSPEC10_1_3_RevokedSidsAbsentOrMalformedFallsBackToSid(t *testing.T) {
	for name, extra := range map[string]any{"absent": nil, "string": "S2", "number": 7} {
		e := newMWEnv(t)
		e.logout = func() map[string]any {
			m := map[string]any{"status": "ok", "sid": "S1"}
			if extra != nil {
				m["revoked_sids"] = extra
			}
			return m
		}
		e.do("POST", "/logout", "", "rt1")
		e.wantRevoked(t, e.token("S1", "u", time.Now()))
		if name != "absent" {
			e.wantPass(t, e.token("S2", "u", time.Now()))
		}
	}
}

func TestSPEC10_1_3_ResponseSidBeatsBearer(t *testing.T) {
	e := newMWEnv(t)
	e.logout = func() map[string]any { return map[string]any{"status": "ok", "sid": "S1"} }
	e.do("POST", "/logout", e.token("S2", "u", time.Now()), "rt1")
	e.wantRevoked(t, e.token("S1", "u", time.Now()))
	e.wantPass(t, e.token("S2", "u", time.Now()))
}

func TestSPEC10_1_3_OlderIssuer_VerifiedUnexpiredBearerFallback(t *testing.T) {
	e := newMWEnv(t) // logout response carries no sid
	e.do("POST", "/logout", e.token("S1", "u", time.Now()), "rt1")
	e.wantRevoked(t, e.token("S1", "u", time.Now()))
}

func TestSPEC10_1_3_ExpiredBearerRevokesNothing(t *testing.T) {
	e := newMWEnv(t)
	expired := e.token("S1", "u", time.Now().Add(-3*time.Hour))
	for i := 0; i < 3; i++ {
		if w := e.do("POST", "/logout", expired, "rt1"); w.Code != 200 {
			t.Fatalf("logout never 401s: %d", w.Code)
		}
	}
	e.wantPass(t, e.token("S1", "u", time.Now()))
}

func TestSPEC10_1_3_IssuerFailureUsesBearerFallbackAndNeverFails(t *testing.T) {
	e := newMWEnv(t)
	e.logoutOK = false
	if w := e.do("POST", "/logout", "", "rt1"); w.Code != 200 {
		t.Fatalf("no bearer, issuer 500: %d", w.Code)
	}
	e.wantPass(t, e.token("S1", "u", time.Now()))
	e.do("POST", "/logout", e.token("S1", "u", time.Now()), "rt1")
	e.wantRevoked(t, e.token("S1", "u", time.Now()))
}

func TestSPEC10_1_6a_GateBeforeMFA_HandlerNotCalled(t *testing.T) {
	e := newMWEnv(t)
	tok := e.token("S1", "u", time.Now())
	e.realm.Tokens.RevokeSession(context.Background(), "S1")
	w := e.do("GET", "/secure", tok, "")
	if w.Code != 401 || !strings.Contains(w.Body.String(), `"revoked":true`) {
		t.Fatalf("revoked on an MFA path must be 401, not 412: %d %s", w.Code, w.Body.String())
	}
	if e.reached != 0 {
		t.Fatal("handler called")
	}
}

func TestSPEC10_1_4b_RotatingRefreshSupersedesOlderTokens(t *testing.T) {
	e := newMWEnv(t)
	e.nextRT = "rt-new"
	older := e.token("S1", "sub1", time.Now().Add(-time.Minute))
	e.wantPass(t, older)
	w := e.do("POST", "/token", "", "rt-old")
	if w.Code != 200 {
		t.Fatalf("refresh: %d %s", w.Code, w.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if body["org_session_mode"] != "exclusive" {
		t.Fatalf("org_session_mode: %v", body["org_session_mode"])
	}
	e.wantRevoked(t, older)
}

func TestSPEC10_1_4b_NonRotatingRefreshRecordsNothing(t *testing.T) {
	for name, echoed := range map[string]string{"same": "rt-old", "empty": ""} {
		e := newMWEnv(t)
		e.nextRT = echoed
		older := e.token("S1", "sub1", time.Now().Add(-time.Minute))
		if w := e.do("POST", "/token", "", "rt-old"); w.Code != 200 {
			t.Fatalf("%s: refresh %d", name, w.Code)
		}
		e.wantPass(t, older)
	}
}

func TestSPEC6_7_3_BodiesCarryOrgSessionMode(t *testing.T) {
	e := newMWEnv(t)
	e.nextRT = "rt-new"
	if got := e.realm.orgSessionModeOf(context.Background(), e.token("S1", "u", time.Now())); got != OrgSessionsExclusive {
		t.Fatalf("mode from discovery: %q", got)
	}
}

// H1 (final critic): the middleware logout route relays `all` from the browser's
// body to the issuer for every candidate (SPEC §10.1 step 3).
func TestSPEC10_1_3_LogoutRelaysAllFromBodyInCookieMode(t *testing.T) {
	e := newMWEnv(t)
	e.logout = func() map[string]any {
		return map[string]any{"status": "ok", "sid": "S1", "revoked_sids": []string{"S1", "S2"}}
	}
	req := httptest.NewRequest("POST", "/logout", strings.NewReader(`{"all":true}`))
	req.AddCookie(&http.Cookie{Name: "realmid_refresh", Value: "rt1"})
	e.h.ServeHTTP(httptest.NewRecorder(), req)
	if len(e.logoutIn) == 0 {
		t.Fatal("issuer logout never called")
	}
	for i, in := range e.logoutIn {
		if in["all"] != true {
			t.Fatalf("candidate %d: issuer must receive all=true, got %v", i, in)
		}
	}
	e.wantRevoked(t, e.token("S2", "u", time.Now()))
}

func TestSPEC10_1_3_LogoutWithoutAllBodySendsNoAll(t *testing.T) {
	e := newMWEnv(t)
	e.do("POST", "/logout", "", "rt1") // body is {"tenant_id":"t1"}
	if len(e.logoutIn) != 1 || e.logoutIn[0]["all"] == true {
		t.Fatalf("all must not be set: %v", e.logoutIn)
	}
}
