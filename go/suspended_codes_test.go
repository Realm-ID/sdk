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
func suspHarness(t *testing.T, body string, mint bool, onFail func(*AuthFailureEvent)) (http.Handler, *spyStore) {
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
