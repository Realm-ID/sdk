package realmid

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// custom_claims_handler_test.go — audit e-01 (owner ruling 3, 2026-11-14).
// Spec: SPEC.md SPEC10_1_4_no_client_claims (§10.1 step 4), SPEC10_1_4a_fingerprint,
// SPEC10_2_custom_claims (§10.2), issuer ADR-065 AF-065.2.

// SPEC10_1_4_no_client_claims: every spelling and every value is refused 400
// before the issuer is called; the refresh token is not consumed.
func TestSPEC10_1_4_BrowserCustomClaimsRefused400(t *testing.T) {
	bodies := []string{
		`{"tenant_id":"t1","custom_claims":{"outlets":["EVERY"]}}`,
		`{"tenant_id":"t1","customClaims":{"k":"v"}}`,
		`{"tenant_id":"t1","custom_claims":null}`,
		`{"tenant_id":"t1","customClaims":{}}`,
		`{"tenant_id":"t1","custom_claims":"x"}`,
		`{"tenant_id":"t1","custom_claims":[1]}`,
	}
	for _, b := range bodies {
		e := newRFEnv(t, rfOpts{})
		w := e.post("/token", "rt-old", b)
		if w.Code != 400 || !strings.Contains(w.Body.String(), "custom_claims_not_accepted") {
			t.Errorf("%s: got %d %s", b, w.Code, w.Body.String())
		}
		if e.issuerCalls() != 0 {
			t.Errorf("%s: issuer must not be called, calls=%d", b, e.issuerCalls())
		}
		// the refresh token was not consumed: a clean refresh now succeeds
		if w2 := e.post("/token", "rt-old", `{"tenant_id":"t1"}`); w2.Code != 200 {
			t.Errorf("%s: token consumed by refusal: %d %s", b, w2.Code, w2.Body.String())
		}
	}
}

// A body without the key still refreshes, and the issuer receives no
// custom_claims when no handler is configured (SPEC10_2 rule 1).
func TestSPEC10_2_NoHandlerMeansNoCustomClaims(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	var got map[string]any
	e.onToken = func(b map[string]any) { got = b }
	if w := e.post("/token", "rt-old", `{"tenant_id":"t1"}`); w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	if _, ok := got["custom_claims"]; ok {
		t.Fatalf("custom_claims must be absent: %v", got)
	}
}

// SPEC10_2 rules 4 and 6: the handler runs on the refresh lane with the settled
// (tenantId, sub), and its output is what the issuer receives. No request data.
func TestSPEC10_2_HandlerOutputReachesIssuerOnRefresh(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	var gotT, gotU string
	e.realm.cfg.CustomClaims = func(_ context.Context, tenantID, userID string) (map[string]any, error) {
		gotT, gotU = tenantID, userID
		return map[string]any{"outlets": []any{"o1"}}, nil
	}
	var bodies []map[string]any
	e.onToken = func(b map[string]any) { bodies = append(bodies, b) }
	if w := e.post("/token", "rt-old", `{"tenant_id":"t1"}`); w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	if gotT != "t1" || gotU != "sub-t1" {
		t.Fatalf("handler inputs: %q %q", gotT, gotU)
	}
	if len(bodies) != 2 {
		t.Fatalf("want mint + re-mint, got %d calls", len(bodies))
	}
	if _, ok := bodies[0]["custom_claims"]; ok {
		t.Fatalf("first mint must carry no custom_claims: %v", bodies[0])
	}
	cc, _ := bodies[1]["custom_claims"].(map[string]any)
	if cc == nil || cc["outlets"] == nil {
		t.Fatalf("re-mint must carry the handler's claims: %v", bodies[1])
	}
}

// SPEC10_2 rule 3: 3 attempts then REFUSE, with a distinct error.
func TestSPEC10_2_HandlerErrorRefusesAfterThreeAttempts(t *testing.T) {
	r := &Realm{cfg: Config{}}
	var n int32
	boom := errors.New("db down")
	r.cfg.CustomClaims = func(context.Context, string, string) (map[string]any, error) {
		atomic.AddInt32(&n, 1)
		return nil, boom
	}
	_, err := r.resolveCustomClaims(context.Background(), "t1", "u1")
	var ce *CustomClaimsError
	if !errors.As(err, &ce) || !errors.Is(err, boom) || ce.Attempts != 3 || n != 3 {
		t.Fatalf("err=%v attempts=%d calls=%d", err, func() int {
			if ce != nil {
				return ce.Attempts
			}
			return -1
		}(), n)
	}
	var re *RealmError
	if errors.As(err, &re) {
		t.Fatal("must not be a *RealmError")
	}
}

func TestSPEC10_2_HandlerAbortsOnCancelledContext(t *testing.T) {
	r := &Realm{cfg: Config{}}
	var n int32
	ctx, cancel := context.WithCancel(context.Background())
	r.cfg.CustomClaims = func(context.Context, string, string) (map[string]any, error) {
		atomic.AddInt32(&n, 1)
		cancel()
		return nil, errors.New("x")
	}
	start := time.Now()
	_, err := r.resolveCustomClaims(ctx, "t", "u")
	if err == nil || n != 1 || time.Since(start) > 40*time.Millisecond {
		t.Fatalf("err=%v calls=%d", err, n)
	}
}

// SPEC10_2 rule 5 + SPEC4_2_claim_fold rule 1: bad keys refuse the mint, naming the key.
func TestSPEC10_2_OutputKeysCheckedBeforeSend(t *testing.T) {
	cases := map[string]bool{"outlets": true, "tenant-id": true, "Role": false, "SCOPE": false, "Product_Roles": false, "events": false, "é": false, "": false, "a\x7f": false}
	for k, ok := range cases {
		r := &Realm{cfg: Config{}}
		r.cfg.CustomClaims = func(context.Context, string, string) (map[string]any, error) {
			return map[string]any{k: 1}, nil
		}
		_, err := r.resolveCustomClaims(context.Background(), "t", "u")
		if ok && err != nil {
			t.Errorf("%q refused: %v", k, err)
		}
		if !ok && (err == nil || (k != "" && !strings.Contains(err.Error(), fmt.Sprintf("%q", k)))) {
			t.Errorf("%q not refused / not named: %v", k, err)
		}
	}
}

// A handler failure on refresh refuses the refresh (503-class), never mints without.
func TestSPEC10_2_RefreshRefusedWhenHandlerFails(t *testing.T) {
	e := newRFEnv(t, rfOpts{})
	e.realm.cfg.CustomClaims = func(context.Context, string, string) (map[string]any, error) {
		return map[string]any{"scope": "x"}, nil // reserved -> refuse
	}
	w := e.post("/token", "rt-old", `{"tenant_id":"t1"}`)
	if w.Code == http.StatusOK {
		t.Fatalf("must refuse: %d %s", w.Code, w.Body.String())
	}
}

// SPEC10_1_4a_fingerprint: a refresh fingerprint is the tenant alone.
func TestSPEC10_1_4a_FingerprintIsTenantOnly(t *testing.T) {
	if refreshFingerprint("t1") != "t1" {
		t.Fatalf("got %q", refreshFingerprint("t1"))
	}
}
