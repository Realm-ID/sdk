package realmid

// S10 (audit rows 2 and 3, 2026-11-14). Spec: sdk/SPEC.md SPEC4_2_carry_all
// rules 1-3 and SPEC10_1 step 4a (a carried failure on the refresh route is a
// 503 hand-over, or the issuer's own status/code when the cause is an issuer
// refusal; never a 401 while a rotated token is carried).

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// secondMintEnv: the 1st /auth/token rotates to R1, the 2nd answers (st, errBody).
func secondMintEnv(t *testing.T, delivery string, st int, errBody string, h CustomClaimsHandler) http.Handler {
	t.Helper()
	_, key := mintTestKey(t, "k1")
	var mu sync.Mutex
	n := 0
	srv := mwTestServer(t, []jwk{key}, testAud, map[string]http.HandlerFunc{
		"/auth/token": func(w http.ResponseWriter, _ *http.Request) {
			mu.Lock()
			n++
			c := n
			mu.Unlock()
			if c >= 2 {
				w.WriteHeader(st)
				_, _ = w.Write([]byte(errBody))
				return
			}
			_ = json.NewEncoder(w).Encode(okMint(1, "u-1"))
		},
	})
	t.Cleanup(srv.Close)
	r, err := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "k", BaseURL: srv.URL, CustomClaims: h})
	if err != nil {
		t.Fatal(err)
	}
	return r.Middleware(MiddlewareOptions{TokenDelivery: delivery})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
}

func claimsOK(context.Context, string, string) (map[string]any, error) {
	return map[string]any{"k": "v"}, nil
}

// SPEC4_2_carry_all rule 3 + audit row 3: a refused second mint keeps the
// issuer's status and code (relayed, not flattened to 401 server_error) AND
// hands the rotated token over.
func TestS10_SecondMintRefusalRelaysIssuerCodeAndHandsOver(t *testing.T) {
	cases := []struct {
		st   int
		body string
		code string
	}{
		{400, `{"error":{"code":"reserved_claim_key","message":"reserved"}}`, "reserved_claim_key"},
		{403, `{"error":{"code":"user_suspended","message":"suspended"}}`, "user_suspended"},
	}
	for _, c := range cases {
		t.Run(c.code, func(t *testing.T) {
			h := secondMintEnv(t, "", c.st, c.body, claimsOK)
			w := driveWith(h, "/token", true, `{"tenant_id":"t1"}`)
			if w.Code != c.st || !strings.Contains(w.Body.String(), `"code":"`+c.code+`"`) {
				t.Fatalf("status %d body %s, want %d %s", w.Code, w.Body.String(), c.st, c.code)
			}
			if got := setCookie(w); got != "R1" {
				t.Errorf("rotated token not handed over: cookie %q", got)
			}
		})
	}
}

// SPEC4_2_carry_all rule 5 / 4a: a handler failure after rotation answers 503,
// never 401, and hands the rotated token over (cookie and body mode).
func TestS10_CarriedHandlerFailureAnswers503(t *testing.T) {
	fail := func(context.Context, string, string) (map[string]any, error) { return nil, errors.New("handler down") }
	for _, delivery := range []string{"", "body"} {
		h := secondMintEnv(t, delivery, 200, `{}`, fail)
		w := driveWith(h, "/token", delivery == "", `{"tenant_id":"t1","refresh_token":"rt-spent"}`)
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("delivery %q: status %d body %s, want 503", delivery, w.Code, w.Body.String())
		}
		if delivery == "body" && !strings.Contains(w.Body.String(), `"refresh_token":"R1"`) {
			t.Errorf("body mode lost the rotated token: %s", w.Body.String())
		}
		if delivery == "" && setCookie(w) != "R1" {
			t.Errorf("cookie mode lost the rotated token: %q", setCookie(w))
		}
	}
}

// asRealmError unwraps RefreshHandedOverError exactly one level.
func TestS10_AsRealmErrorUnwrapsHandOverOneLevel(t *testing.T) {
	inner := &RealmError{Code: "reserved_claim_key", HTTPStatus: 400, Message: "m"}
	if got := asRealmError(&RefreshHandedOverError{err: inner, refreshToken: "x"}); got != inner {
		t.Fatalf("got %+v, want the inner RealmError", got)
	}
	deep := &RefreshHandedOverError{err: &CustomClaimsError{Err: inner}, refreshToken: "x"}
	if got := asRealmError(deep); got.Code != ErrCodeServerError {
		t.Fatalf("one level only: got %q", got.Code)
	}
}
