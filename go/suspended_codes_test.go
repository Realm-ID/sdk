package realmid

// Issuer ADR-104 R-d: the two 403 refusals for a suspended/deactivated row.
// The fake issuer bodies are the issuer's REAL wire shape: apiErr.Response()
// is the flat `{"error":"<msg>","code":"<code>"}` (issuer types.go), written by
// errForbidden("user_suspended", "user is suspended") (verify.go, auth.go) and
// errForbidden("escort_suspended", "the escort's account is suspended or
// deactivated") (bff_gate.go).

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
	userSuspendedBody   = `{"error":"user is suspended","code":"user_suspended"}`
	escortSuspendedBody = `{"error":"the escort's account is suspended or deactivated","code":"escort_suspended"}`
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

func TestSuspendedCodes_TokenLevelErrIsFalse(t *testing.T) {
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

func TestSuspendedCodes_MiddlewareRelaysWithoutTeardown(t *testing.T) {
	for _, tc := range []struct {
		name       string
		body       string
		wantStatus int
		wantCode   string
	}{
		{"user_suspended", userSuspendedBody, 403, "user_suspended"},
		{"escort_suspended", escortSuspendedBody, 503, "escort_suspended"},
	} {
		for _, path := range []string{"/token", "/login", "/mfa/verify", "/mfa/recovery"} {
			t.Run(tc.name+path, func(t *testing.T) {
				sign, key := mintTestKey(t, "k1")
				_ = sign
				fail := func(w http.ResponseWriter, _ *http.Request) {
					w.WriteHeader(403)
					_, _ = w.Write([]byte(tc.body))
				}
				srv := mwTestServer(t, []jwk{key}, testAud, map[string]http.HandlerFunc{
					"/auth/token": fail, "/auth/login": fail,
					"/auth/mfa/verify": fail, "/auth/mfa/recovery": fail,
				})
				t.Cleanup(srv.Close)
				store := &spyStore{MemorySessionStore: NewMemorySessionStore()}
				r, err := NewRealm(Config{SessionStore: store, RealmID: testRealmID, APIKey: "k", BaseURL: srv.URL})
				if err != nil {
					t.Fatal(err)
				}
				h := r.Middleware(MiddlewareOptions{RecoveryPath: "/mfa/recovery"})(
					http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))

				reqBody := `{"tenant_id":"t1","method":"firebase","provider_token":"p","challenge_token":"c","code":"1"}`
				req := httptest.NewRequest("POST", path, strings.NewReader(reqBody))
				req.AddCookie(&http.Cookie{Name: "realmid_refresh", Value: "rt-live"})
				w := httptest.NewRecorder()
				h.ServeHTTP(w, req)

				if w.Code != tc.wantStatus {
					t.Fatalf("status %d, want %d: %s", w.Code, tc.wantStatus, w.Body.String())
				}
				if !strings.Contains(w.Body.String(), `"code":"`+tc.wantCode+`"`) {
					t.Fatalf("body lacks code %s: %s", tc.wantCode, w.Body.String())
				}
				for _, c := range w.Result().Cookies() {
					if c.Name == "realmid_refresh" {
						t.Errorf("refresh cookie touched (MaxAge=%d): a suspension in one org must not end the session", c.MaxAge)
					}
				}
				if n := store.writes.Load(); n != 0 {
					t.Errorf("SessionStore written %d times, want 0", n)
				}
			})
		}
	}
}
