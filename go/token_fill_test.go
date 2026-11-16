package realmid

// S9 (audit rows 1 and 3, 2026-11-14). Spec: sdk/SPEC.md SPEC4_2_fill,
// SPEC4_2_rotate_handover (incl. rule 5, the middleware refresh route),
// SPEC4_2_claim_fold rule 2 (peekJWTUserFields / peekJWTIssuer).

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func fillJWT(payload string) string {
	e := base64.RawURLEncoding.EncodeToString
	return e([]byte(`{"alg":"none"}`)) + "." + e([]byte(payload)) + ".sig"
}

// fillEnv is a fake issuer whose /auth/token records every body and answers
// from `answer`.
type fillEnv struct {
	realm  *Realm
	mu     sync.Mutex
	bodies []map[string]any
	// answer returns (status, body) for the nth /auth/token call (1-based).
	answer func(n int, body map[string]any) (int, map[string]any)
}

func okMint(n int, sub string) map[string]any {
	return map[string]any{
		"status": "ok", "subject_type": "user",
		"access_token":  fillJWT(fmt.Sprintf(`{"sub":%q,"n":%d}`, sub, n)),
		"refresh_token": fmt.Sprintf("R%d", n),
		"expires_in":    3600, "tenant_id": "t1", "role": "member",
	}
}

func newFillEnv(t *testing.T, h CustomClaimsHandler, answer func(n int, body map[string]any) (int, map[string]any)) *fillEnv {
	t.Helper()
	e := &fillEnv{answer: answer}
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/token", platformMintThen(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		e.mu.Lock()
		e.bodies = append(e.bodies, body)
		n := len(e.bodies)
		e.mu.Unlock()
		st, resp := e.answer(n, body)
		w.WriteHeader(st)
		_ = json.NewEncoder(w).Encode(resp)
	}))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	r, err := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk_live_test", BaseURL: srv.URL, CustomClaims: h})
	if err != nil {
		t.Fatal(err)
	}
	e.realm = r
	return e
}

func (e *fillEnv) userBodies() []map[string]any {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]map[string]any(nil), e.bodies...)
}

func defaultAnswer(n int, _ map[string]any) (int, map[string]any) { return 200, okMint(n, "u-1") }

// SPEC4_2_fill: a direct Token call that omits CustomClaims is filled from the handler.
func TestSPEC4_2_fill_DirectTokenFillsFromHandler(t *testing.T) {
	var gotT, gotU string
	e := newFillEnv(t, func(_ context.Context, tn, u string) (map[string]any, error) {
		gotT, gotU = tn, u
		return map[string]any{"outlets": []any{"o1"}}, nil
	}, defaultAnswer)
	mr, err := e.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: "R0", TenantID: "t1"})
	if err != nil {
		t.Fatal(err)
	}
	b := e.userBodies()
	if len(b) != 2 {
		t.Fatalf("want mint + re-mint, got %d", len(b))
	}
	if _, ok := b[0]["custom_claims"]; ok {
		t.Fatalf("first mint carries claims: %v", b[0])
	}
	if cc, _ := b[1]["custom_claims"].(map[string]any); cc["outlets"] == nil || b[1]["refresh_token"] != "R1" {
		t.Fatalf("re-mint must carry the claims on the ROTATED token: %v", b[1])
	}
	if gotT != "t1" || gotU != "u-1" || mr.RefreshToken != "R2" {
		t.Fatalf("handler (%q,%q), result refresh %q", gotT, gotU, mr.RefreshToken)
	}
}

// An EMPTY non-nil map is the caller's explicit "none": no handler, one mint.
func TestSPEC4_2_fill_EmptyMapIsExplicitNone(t *testing.T) {
	called := false
	e := newFillEnv(t, func(context.Context, string, string) (map[string]any, error) {
		called = true
		return map[string]any{"x": 1}, nil
	}, defaultAnswer)
	if _, err := e.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: "R0", TenantID: "t1", CustomClaims: map[string]any{}}); err != nil {
		t.Fatal(err)
	}
	if called || len(e.userBodies()) != 1 {
		t.Fatalf("handler called=%v mints=%d", called, len(e.userBodies()))
	}
}

// A handler returning nothing means no re-mint; a tokenless rotation is returned as minted.
func TestSPEC4_2_fill_EmptyHandlerOutputAndTokenlessRotation(t *testing.T) {
	e := newFillEnv(t, func(context.Context, string, string) (map[string]any, error) { return nil, nil }, defaultAnswer)
	if _, err := e.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: "R0", TenantID: "t1"}); err != nil || len(e.userBodies()) != 1 {
		t.Fatalf("err=%v mints=%d", err, len(e.userBodies()))
	}
	called := false
	e2 := newFillEnv(t, func(context.Context, string, string) (map[string]any, error) {
		called = true
		return map[string]any{"x": 1}, nil
	}, func(n int, _ map[string]any) (int, map[string]any) {
		m := okMint(n, "u-1")
		delete(m, "refresh_token")
		return 200, m
	})
	if _, err := e2.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: "R0", TenantID: "t1"}); err != nil || called || len(e2.userBodies()) != 1 {
		t.Fatalf("err=%v called=%v mints=%d", err, called, len(e2.userBodies()))
	}
}

// SPEC4_2_fill via the TokenManager (which calls Token).
func TestSPEC4_2_fill_TokenManagerMintsWithHandlerClaims(t *testing.T) {
	e := newFillEnv(t, func(context.Context, string, string) (map[string]any, error) {
		return map[string]any{"outlets": []any{"o1"}}, nil
	}, defaultAnswer)
	m := e.realm.Auth.NewTokenManager("R0", WithTokenManagerTenant("t1"))
	if _, err := m.AccessToken(context.Background()); err != nil {
		t.Fatal(err)
	}
	b := e.userBodies()
	if len(b) != 2 || b[1]["custom_claims"] == nil {
		t.Fatalf("manager mint lacks the handler's claims: %v", b)
	}
	if m.RefreshToken() != "R2" {
		t.Fatalf("manager token %q", m.RefreshToken())
	}
}

func assertCarried(t *testing.T, err error, wantRefresh, wantAccessSub string) *RefreshHandedOverError {
	t.Helper()
	var ho *RefreshHandedOverError
	if !errors.As(err, &ho) {
		t.Fatalf("want *RefreshHandedOverError, got %T %v", err, err)
	}
	if ho.RefreshToken() != wantRefresh {
		t.Fatalf("carried refresh %q want %q", ho.RefreshToken(), wantRefresh)
	}
	if !strings.Contains(ho.AccessToken(), ".") {
		t.Fatalf("carried access token missing: %q", ho.AccessToken())
	}
	for _, s := range []string{err.Error(), fmt.Sprintf("%v|%+v|%#v|%s", err, err, ho, ho)} {
		if strings.Contains(s, wantRefresh+"\"") || strings.Contains(s, ho.AccessToken()) {
			t.Fatalf("credential leaked into %q", s)
		}
	}
	if b, _ := json.Marshal(ho); strings.Contains(string(b), ho.AccessToken()) || strings.Contains(string(b), `"`+wantRefresh+`"`) {
		t.Fatalf("credential leaked into JSON %s", b)
	}
	return ho
}

// SPEC4_2_rotate_handover vector: handler always fails; token() carries the rotated session.
func TestSPEC4_2_rotate_handover_HandlerFailureCarriesSession(t *testing.T) {
	e := newFillEnv(t, func(context.Context, string, string) (map[string]any, error) {
		return nil, errors.New("handler down")
	}, defaultAnswer)
	_, err := e.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: "R0", TenantID: "t1"})
	assertCarried(t, err, "R1", "u-1")
	var ce *CustomClaimsError
	if !errors.As(err, &ce) || ce.Attempts != 3 {
		t.Fatalf("original must be *CustomClaimsError after 3 attempts: %v", err)
	}
	if n := len(e.userBodies()); n != 1 {
		t.Fatalf("no second mint expected, got %d mints", n)
	}
}

// Same vector, second mint refused (400): carried original is that RealmError.
func TestSPEC4_2_rotate_handover_SecondMintRefusedCarriesSession(t *testing.T) {
	e := newFillEnv(t, func(context.Context, string, string) (map[string]any, error) {
		return map[string]any{"k": 1}, nil
	}, func(n int, _ map[string]any) (int, map[string]any) {
		if n == 2 {
			return 400, map[string]any{"error": map[string]any{"code": "reserved_claim_key", "message": "no"}}
		}
		return defaultAnswer(n, nil)
	})
	_, err := e.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: "R0", TenantID: "t1"})
	assertCarried(t, err, "R1", "u-1")
	var re *RealmError
	if !errors.As(err, &re) || re.HTTPStatus != 400 {
		t.Fatalf("original must be the issuer's 400: %v", err)
	}
}

// A refused FIRST mint carries nothing (nothing was rotated).
func TestSPEC4_2_rotate_handover_FirstMintRefusedCarriesNothing(t *testing.T) {
	e := newFillEnv(t, func(context.Context, string, string) (map[string]any, error) { return map[string]any{"k": 1}, nil },
		func(int, map[string]any) (int, map[string]any) {
			return 401, map[string]any{"error": map[string]any{"code": "refresh_invalid", "message": "dead"}}
		})
	_, err := e.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: "R0", TenantID: "t1"})
	var ho *RefreshHandedOverError
	if err == nil || errors.As(err, &ho) {
		t.Fatalf("want a plain error, got %T %v", err, err)
	}
}

// Decision (c): an unreadable sub refuses with the handler error type, carrying the session.
func TestSPEC4_2_rotate_handover_UnreadableSubCarriesSession(t *testing.T) {
	for name, payload := range map[string]string{
		"nosub":    `{"n":1}`,
		"foldsub":  `{"sub":"me","Sub":"victim"}`,
		"notjson":  `nope`,
		"emptysub": `{"sub":""}`,
	} {
		called := false
		e := newFillEnv(t, func(context.Context, string, string) (map[string]any, error) {
			called = true
			return map[string]any{"k": 1}, nil
		}, func(n int, _ map[string]any) (int, map[string]any) {
			m := okMint(n, "x")
			m["access_token"] = fillJWT(payload)
			return 200, m
		})
		_, err := e.realm.Auth.Token(context.Background(), TokenRequest{RefreshToken: "R0", TenantID: "t1"})
		assertCarried(t, err, "R1", "")
		var ce *CustomClaimsError
		if !errors.As(err, &ce) || called {
			t.Fatalf("%s: want *CustomClaimsError without calling the handler (called=%v): %v", name, called, err)
		}
	}
}

// TokenManager adopts the carried session: the next acquisition presents R1.
func TestSPEC4_2_rotate_handover_TokenManagerAdoptsCarriedSession(t *testing.T) {
	fail := true
	e := newFillEnv(t, func(context.Context, string, string) (map[string]any, error) {
		if fail {
			return nil, errors.New("handler down")
		}
		return map[string]any{"k": 1}, nil
	}, defaultAnswer)
	var sunk []string
	m := e.realm.Auth.NewTokenManager("R0", WithTokenManagerTenant("t1"), WithRefreshSink(func(_ context.Context, rt string) error {
		sunk = append(sunk, rt)
		return nil
	}))
	if _, err := m.AccessToken(context.Background()); err == nil {
		t.Fatal("want the acquisition to fail")
	}
	if m.RefreshToken() != "R1" || len(sunk) != 1 || sunk[0] != "R1" {
		t.Fatalf("manager token %q sunk %v", m.RefreshToken(), sunk)
	}
	fail = false
	if _, err := m.AccessToken(context.Background()); err != nil {
		t.Fatal(err)
	}
	b := e.userBodies()
	if got := b[len(b)-2]["refresh_token"]; got != "R1" {
		t.Fatalf("recovery presented %v, want R1; bodies=%v", got, b)
	}
}

// SPEC4_2_claim_fold rule 2: the unverified readers refuse a fold-collision payload.
func TestSPEC4_2_claim_fold_PeekReadersRefuseFoldPayload(t *testing.T) {
	jwt := fillJWT(`{"sub":"me","Sub":"victim","iss":"https://a","Iss":"https://evil"}`)
	if sub, _, _, err := peekJWTUserFields(jwt); err == nil && sub != "" {
		t.Fatalf("peekJWTUserFields resolved %q from a fold payload", sub)
	}
	if iss, err := peekJWTIssuer(jwt); err == nil && iss != "" {
		t.Fatalf("peekJWTIssuer resolved %q from a fold payload", iss)
	}
	// positive control
	if sub, _, _, err := peekJWTUserFields(fillJWT(`{"sub":"me","email":"e","name":"n"}`)); err != nil || sub != "me" {
		t.Fatalf("clean payload: %q %v", sub, err)
	}
	if iss, err := peekJWTIssuer(fillJWT(`{"iss":"https://a"}`)); err != nil || iss != "https://a" {
		t.Fatalf("clean issuer: %q %v", iss, err)
	}
}

// Rule 5: the middleware refresh route hands the rotated token to the browser on a
// post-rotation handler failure (cookie and body mode), with the error answered.
func TestSPEC4_2_rotate_handover_MiddlewareRefreshHandsRotatedTokenToBrowser(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	e.realm.cfg.CustomClaims = func(context.Context, string, string) (map[string]any, error) {
		return nil, errors.New("handler down")
	}
	w := e.post("/token", "rt-old", `{"tenant_id":"t1"}`)
	if w.Code == 200 {
		t.Fatalf("handler failure must not answer 200: %s", w.Body.String())
	}
	if got := setCookie(w); got != "rt-new-1" {
		t.Fatalf("cookie mode: rotated token not handed over, Set-Cookie=%q body=%s", got, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "rt-new-1") {
		t.Fatalf("cookie mode must not put the token in the body: %s", w.Body.String())
	}
	// A retry inside the window presents the rotated token, not the spent one.
	w2 := e.post("/token", "rt-new-1", `{"tenant_id":"t1"}`)
	if seen := e.seenTokens(); len(seen) < 2 || seen[1] != "rt-new-1" {
		t.Fatalf("retry presented %v (code %d)", seen, w2.Code)
	}

	eb := newRFEnv(t, rfOpts{opts: MiddlewareOptions{TokenDelivery: "body"}})
	eb.realm.cfg.CustomClaims = e.realm.cfg.CustomClaims
	wb := eb.post("/token", "", `{"tenant_id":"t1","refresh_token":"rt-old"}`)
	var out map[string]any
	_ = json.Unmarshal(wb.Body.Bytes(), &out)
	if out["refresh_token"] != "rt-new-1" || wb.Code == 200 {
		t.Fatalf("body mode: %d %s", wb.Code, wb.Body.String())
	}
}
