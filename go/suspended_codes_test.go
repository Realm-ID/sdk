package realmid

// Issuer ADR-104 R-d: the two refusals for a suspended/deactivated row.
//
// WIRE SHAPE. GoFr v1.62.0 NESTS the issuer's apiErr: the body is
// `{"error":{"code":"…","error":"…","message":"…"}}` (SPEC §3.1; the issuer's
// integration parseEnvelope, test/integration/mfa_test.go). The flat
// `{"error":"…","code":"…"}` is what apiErr.Response() builds BEFORE GoFr wraps
// it; it is kept below as ONE legacy-tolerance case, not as the wire.
// Sources of the refusals: verify.go / auth.go (user_suspended, 403),
// bff_gate.go (escort_suspended, 403), user_api_keys_handlers.go (user_suspended, 401).

import (
	ctxpkg "context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const (
	userSuspendedBody   = `{"error":{"code":"user_suspended","error":"user is suspended","message":"user is suspended"}}`
	escortSuspendedBody = `{"error":{"code":"escort_suspended","error":"the escort's account is suspended or deactivated","message":"the escort's account is suspended or deactivated"}}`
	// legacyFlatUserSuspendedBody is the pre-GoFr-wrap shape; tolerated, not the wire.
	legacyFlatUserSuspendedBody = `{"error":"user is suspended","code":"user_suspended"}`
)

func TestSuspendedCodes_RegisteredAndPredicates(t *testing.T) {
	if !isKnownCode("user_suspended") || !isKnownCode("escort_suspended") {
		t.Fatal("user_suspended / escort_suspended must be in knownCodes")
	}
	for _, tc := range []struct {
		name string
		body string
		code ErrorCode
		is   func(error) bool
		not  func(error) bool
	}{
		{"user", userSuspendedBody, ErrCodeUserSuspended, IsUserSuspended, IsEscortSuspended},
		{"escort", escortSuspendedBody, ErrCodeEscortSuspended, IsEscortSuspended, IsUserSuspended},
		{"user-legacy-flat", legacyFlatUserSuspendedBody, ErrCodeUserSuspended, IsUserSuspended, IsEscortSuspended},
	} {
		direct := &RealmError{Code: tc.code, HTTPStatus: 403}
		if !tc.is(direct) || tc.not(direct) {
			t.Errorf("%s: registered Code not recognised exactly", tc.name)
		}
		parsed := ParseErrorEnvelope([]byte(tc.body), 403)
		if parsed.Code != tc.code {
			t.Fatalf("%s: issuer body parsed to Code %q, want %q (not registered?)", tc.name, parsed.Code, tc.code)
		}
		wrapped := errors.Join(errors.New("ctx"), parsed)
		if !tc.is(wrapped) || tc.not(wrapped) {
			t.Errorf("%s: issuer body error not recognised", tc.name)
		}
		if IsTokenStale(parsed) || IsUnauthorized(parsed) {
			t.Errorf("%s: must not read as stale/401", tc.name)
		}
	}
	if IsUserSuspended(nil) || IsEscortSuspended(errors.New("x")) {
		t.Error("nil / foreign error must be false")
	}
}

func TestSuspendedCodes_ProxyStatus(t *testing.T) {
	st, code, _ := ProxyStatus(ParseErrorEnvelope([]byte(userSuspendedBody), 403))
	if st != 403 || code != "user_suspended" {
		t.Errorf("user_suspended -> %d %q, want 403 user_suspended", st, code)
	}
	st, code, _ = ProxyStatus(ParseErrorEnvelope([]byte(escortSuspendedBody), 403))
	if st != 503 || code != "escort_suspended" {
		t.Errorf("escort_suspended -> %d %q, want 503 escort_suspended", st, code)
	}
}

func TestSuspendedCodes_TokenLevelErrIsFalseFor403(t *testing.T) {
	for _, b := range []string{userSuspendedBody, escortSuspendedBody} {
		re := ParseErrorEnvelope([]byte(b), 403)
		if tokenLevelErr(&storedErr{Code: string(re.Code), Status: 403}) {
			t.Errorf("%s must not be token-level", re.Code)
		}
	}
}

// spyStore counts every write that would tear a session down.
type spyStore struct {
	*MemorySessionStore
	writes atomic.Int32
}

func (s *spyStore) RevokeSession(c ctxpkg.Context, k string, u time.Time) error {
	s.writes.Add(1)
	return s.MemorySessionStore.RevokeSession(c, k, u)
}
func (s *spyStore) RaiseNotBefore(c ctxpkg.Context, k string, nb, u time.Time) error {
	s.writes.Add(1)
	return s.MemorySessionStore.RaiseNotBefore(c, k, nb, u)
}

type suspCase struct {
	name       string
	body       string
	wantStatus int
	wantCode   string
}

var suspCases = []suspCase{
	{"user_suspended", userSuspendedBody, 403, "user_suspended"},
	{"escort_suspended", escortSuspendedBody, 503, "escort_suspended"},
	{"legacy_flat_user_suspended", legacyFlatUserSuspendedBody, 403, "user_suspended"},
}

// suspHarness builds a middleware over a fake issuer. direct: the listed
// /auth/* routes answer the refusal themselves. mint: login/MFA routes succeed
// (handing back rotated refresh token "rt-rotated" and a tenant) and the
// follow-up /auth/token MINT is refused, so the error reaches the middleware
// wrapped in *LoginMintError.
func suspHarness(t *testing.T, body string, mint bool, onFail func(*AuthFailureEvent), delivery ...string) (http.Handler, *spyStore) {
	t.Helper()
	sign, key := mintTestKey(t, "k1")
	refuse := func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(403)
		_, _ = w.Write([]byte(body))
	}
	session := func(w http.ResponseWriter, _ *http.Request) {
		now := time.Now().Unix()
		access := sign(map[string]any{
			"iss": "x", "sub": "u1", "aud": testAud, "iat": now, "exp": now + 600,
		})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","access_token":"` + access +
			`","refresh_token":"rt-rotated","expires_in":900,"tenant_id":"t1"}`))
	}
	routes := map[string]http.HandlerFunc{"/auth/token": refuse}
	if mint {
		routes["/auth/login"] = session
		routes["/auth/mfa/verify"] = session
		routes["/auth/mfa/recovery"] = session
	} else {
		routes["/auth/login"] = refuse
		routes["/auth/mfa/verify"] = refuse
		routes["/auth/mfa/recovery"] = refuse
	}
	srv := mwTestServer(t, []jwk{key}, testAud, routes)
	t.Cleanup(srv.Close)
	store := &spyStore{MemorySessionStore: NewMemorySessionStore()}
	cfg := Config{SessionStore: store, RealmID: testRealmID, APIKey: "k", BaseURL: srv.URL}
	if mint {
		// Configuring a derived-claims handler is what makes the mint run
		// (auth.go mintProductRoles).
		cfg.Scopes = func(_ ctxpkg.Context, _, _ string) ([]string, error) { return []string{"a:read"}, nil }
	}
	r, err := NewRealm(cfg)
	if err != nil {
		t.Fatal(err)
	}
	opts := MiddlewareOptions{RecoveryPath: "/mfa/recovery"}
	if len(delivery) > 0 {
		opts.TokenDelivery = delivery[0]
	}
	if onFail != nil {
		opts.OnAuthFailure = func(_ ctxpkg.Context, ev *AuthFailureEvent) { onFail(ev) }
	}
	return r.Middleware(opts)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })), store
}

func suspDrive(h http.Handler, path string) *httptest.ResponseRecorder {
	reqBody := `{"tenant_id":"t1","method":"firebase","provider_token":"p","challenge_token":"c","code":"1"}`
	req := httptest.NewRequest("POST", path, strings.NewReader(reqBody))
	req.AddCookie(&http.Cookie{Name: "realmid_refresh", Value: "rt-spent"})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

func checkRelayed(t *testing.T, w *httptest.ResponseRecorder, store *spyStore, tc suspCase) {
	t.Helper()
	if w.Code != tc.wantStatus {
		t.Fatalf("status %d, want %d: %s", w.Code, tc.wantStatus, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"code":"`+tc.wantCode+`"`) {
		t.Fatalf("body lacks code %s: %s", tc.wantCode, w.Body.String())
	}
	if n := store.writes.Load(); n != 0 {
		t.Errorf("SessionStore written %d times, want 0", n)
	}
}

func refreshCookie(w *httptest.ResponseRecorder) (*http.Cookie, bool) {
	for _, c := range w.Result().Cookies() {
		if c.Name == "realmid_refresh" {
			return c, true
		}
	}
	return nil, false
}

// The issuer refuses the /auth/* call itself.
func TestSuspendedCodes_MiddlewareRelaysWithoutTeardown(t *testing.T) {
	for _, tc := range suspCases {
		for _, path := range []string{"/token", "/login", "/mfa/verify", "/mfa/recovery"} {
			t.Run(tc.name+path, func(t *testing.T) {
				h, store := suspHarness(t, tc.body, false, nil)
				w := suspDrive(h, path)
				checkRelayed(t, w, store, tc)
				if c, ok := refreshCookie(w); ok {
					t.Errorf("refresh cookie touched (MaxAge=%d): a suspension in one org must not end the session", c.MaxAge)
				}
			})
		}
	}
}

// The issuer accepts login / the second factor and REFUSES the tenant mint that
// follows: the error reaches the middleware wrapped in *LoginMintError, which a
// direct type assertion flattened to 401 server_error.
func TestSuspendedCodes_WrappedMintRefusalIsRelayed(t *testing.T) {
	for _, tc := range suspCases {
		for _, path := range []string{"/login", "/mfa/verify", "/mfa/recovery"} {
			t.Run(tc.name+path, func(t *testing.T) {
				h, store := suspHarness(t, tc.body, true, nil)
				w := suspDrive(h, path)
				checkRelayed(t, w, store, tc)
				c, ok := refreshCookie(w)
				if path == "/login" {
					if ok && c.MaxAge < 0 {
						t.Errorf("login: refresh cookie cleared")
					}
					return
				}
				// MFA verify/recovery: the issuer rotated the refresh token before
				// the mint was refused. The cookie must carry the NEW one, or the
				// next refresh presents the spent token and trips reuse detection.
				if !ok || c.Value != "rt-rotated" || c.MaxAge < 0 {
					t.Errorf("cookie = %+v (present %v), want the rotated token rt-rotated", c, ok)
				}
			})
		}
	}
}

// OnAuthFailure observes the status the SPA is shown, not the upstream one.
func TestSuspendedCodes_OnAuthFailureSeesRelayedStatus(t *testing.T) {
	for _, tc := range suspCases {
		t.Run(tc.name, func(t *testing.T) {
			var seen int
			h, _ := suspHarness(t, tc.body, false, func(ev *AuthFailureEvent) { seen = ev.Err.HTTPStatus })
			w := suspDrive(h, "/token")
			if seen != tc.wantStatus || w.Code != tc.wantStatus {
				t.Errorf("hook saw %d, response %d, want both %d", seen, w.Code, tc.wantStatus)
			}
		})
	}
}

// ---- narrowing: only the ISSUER's refusal is relayed; partner hooks never are ----

const hookWrapMsg = "partner hook internals"

// hookHarness: the issuer accepts login / MFA / refresh, and the partner's
// OnIdentityResolved hook refuses with a wrapped SDK error carrying its own code,
// status and Details. Nothing of that may reach the SPA.
func hookHarness(t *testing.T, delivery string) http.Handler {
	t.Helper()
	sign, key := mintTestKey(t, "k1")
	session := func(w http.ResponseWriter, _ *http.Request) {
		now := time.Now().Unix()
		access := sign(map[string]any{"iss": "x", "sub": "u1", "aud": testAud, "iat": now, "exp": now + 600})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","access_token":"` + access +
			`","refresh_token":"rt-rotated","expires_in":900,"tenant_id":"t1","role":"member"}`))
	}
	srv := mwTestServer(t, []jwk{key}, testAud, map[string]http.HandlerFunc{
		"/auth/token": session, "/auth/login": session,
		"/auth/mfa/verify": session, "/auth/mfa/recovery": session,
	})
	t.Cleanup(srv.Close)
	r, err := NewRealm(Config{
		SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "k", BaseURL: srv.URL,
		OnIdentityResolved: func(_ ctxpkg.Context, _ *IdentityResolvedEvent) error {
			return fmt.Errorf("%s: %w", hookWrapMsg, &RealmError{
				Code: ErrCodeForbidden, HTTPStatus: 403, Message: hookWrapMsg,
				Details: map[string]any{"leak": "yes"},
			})
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return r.Middleware(MiddlewareOptions{RecoveryPath: "/mfa/recovery", TokenDelivery: delivery})(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
}

func driveWith(h http.Handler, path string, cookie bool, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", path, strings.NewReader(body))
	if cookie {
		req.AddCookie(&http.Cookie{Name: "realmid_refresh", Value: "rt-spent"})
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

const mfaReqBody = `{"tenant_id":"t1","method":"firebase","provider_token":"p","challenge_token":"c","code":"1","refresh_token":"rt-spent"}`

// A partner-wrapped SDK error answers 401 server_error on login, MFA and refresh,
// leaks nothing, and an MFA hook refusal writes NO cookie (documented contract).
func TestSuspendedCodes_PartnerHookRefusalIsNotRelayedAndWritesNoCookie(t *testing.T) {
	for _, path := range []string{"/login", "/mfa/verify", "/mfa/recovery", "/token"} {
		t.Run(path, func(t *testing.T) {
			w := driveWith(hookHarness(t, ""), path, true, mfaReqBody)
			if w.Code != 401 || !strings.Contains(w.Body.String(), `"code":"server_error"`) {
				t.Fatalf("status %d body %s, want 401 server_error", w.Code, w.Body.String())
			}
			if strings.Contains(w.Body.String(), "leak") || strings.Contains(w.Body.String(), `"code":"forbidden"`) {
				t.Errorf("partner hook internals leaked to the SPA: %s", w.Body.String())
			}
			if c, ok := refreshCookie(w); ok {
				t.Errorf("cookie written for a hook refusal: %+v", c)
			}
		})
	}
}

// First-login MFA (no prior session in the browser): an error response must not
// CREATE one, even on an issuer refusal (login's identical failure writes none).
func TestSuspendedCodes_FirstLoginMFARefusalWritesNoCookie(t *testing.T) {
	for _, path := range []string{"/mfa/verify", "/mfa/recovery"} {
		t.Run(path, func(t *testing.T) {
			h, _ := suspHarness(t, userSuspendedBody, true, nil)
			w := driveWith(h, path, false, `{"tenant_id":"t1","challenge_token":"c","code":"1"}`)
			if w.Code != 403 {
				t.Fatalf("status %d: %s", w.Code, w.Body.String())
			}
			if c, ok := refreshCookie(w); ok {
				t.Errorf("first-login MFA error response created a session cookie: %+v", c)
			}
		})
	}
}

// TokenDelivery "body": the rotated token rides in the error body (same rule as
// the cookie: issuer refusal + prior session), as refresh_flight.go does on 503.
func TestSuspendedCodes_BodyDeliveryCarriesRotatedTokenOnIssuerRefusal(t *testing.T) {
	for _, path := range []string{"/mfa/verify", "/mfa/recovery"} {
		t.Run(path, func(t *testing.T) {
			h, _ := suspHarness(t, userSuspendedBody, true, nil, "body")
			w := driveWith(h, path, false, mfaReqBody)
			if w.Code != 403 || !strings.Contains(w.Body.String(), `"refresh_token":"rt-rotated"`) {
				t.Fatalf("status %d body %s, want 403 carrying refresh_token rt-rotated", w.Code, w.Body.String())
			}
		})
	}
	// ...but not for a partner-hook refusal.
	w := driveWith(hookHarness(t, "body"), "/mfa/verify", false, mfaReqBody)
	if strings.Contains(w.Body.String(), "refresh_token") {
		t.Errorf("hook refusal leaked a refresh token into the body: %s", w.Body.String())
	}
}

// The CHANGELOG claim: other issuer mint refusals are relayed too once the
// *LoginMintError is unwrapped. mfa_required on login becomes the 200
// status:mfa_required reply; session_limit_reached keeps its code.
func TestSuspendedCodes_OtherIssuerMintRefusalsAreRelayed(t *testing.T) {
	h, _ := suspHarness(t, `{"error":{"code":"mfa_required","message":"mfa","mfa_challenge_token":"ct1"}}`, true, nil)
	w := suspDrive(h, "/login")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"status":"mfa_required"`) {
		t.Errorf("mfa_required mint refusal: %d %s, want 200 status:mfa_required", w.Code, w.Body.String())
	}
	h, _ = suspHarness(t, `{"error":{"code":"session_limit_reached","message":"limit"}}`, true, nil)
	w = suspDrive(h, "/login")
	if !strings.Contains(w.Body.String(), `"code":"session_limit_reached"`) {
		t.Errorf("session_limit_reached mint refusal not relayed: %d %s", w.Code, w.Body.String())
	}
}
