package realmid

import (
	"strings"
	"testing"
)

// custom_claims_routes_test.go — audit e-01 on the remaining ingress routes.
// Spec: SPEC.md SPEC10_1_4_no_client_claims (§10.1 step 4, owner ruling 3):
// a browser-sent custom_claims / customClaims, with ANY value, is refused
// 400 custom_claims_not_accepted before any issuer call, on the login (step 2),
// MFA verify (step 5) and recovery (step 5a) routes as well as refresh.
func TestSPEC10_1_4_BrowserCustomClaimsRefusedOnLoginAndMFARoutes(t *testing.T) {
	routes := []struct{ name, path, base string }{
		{"login", "/login", `"provider_token":"p","tenant_id":"t1"`},
		{"mfa-verify", "/mfa/verify", `"challenge_token":"c","code":"123456"`},
		{"mfa-recovery", "/mfa/recovery", `"challenge_token":"c","code":"abcd-efgh"`},
	}
	extras := []string{
		`"custom_claims":{"outlets":["EVERY"]}`,
		`"customClaims":{"k":"v"}`,
		`"custom_claims":null`,
		`"customClaims":{}`,
		`"custom_claims":"x"`,
		`"custom_claims":[1]`,
	}
	n := 0
	for _, rt := range routes {
		for _, x := range extras {
			e := newRFEnv(t, rfOpts{opts: MiddlewareOptions{RecoveryPath: "/mfa/recovery"}})
			body := "{" + rt.base + "," + x + "}"
			w := e.post(rt.path, "rt-old", body)
			n++
			if w.Code != 400 || !strings.Contains(w.Body.String(), "custom_claims_not_accepted") {
				t.Errorf("%s %s: got %d %s", rt.name, x, w.Code, w.Body.String())
			}
			if c := e.issuerCalls() + e.mfaCalls + e.recCalls; c != 0 {
				t.Errorf("%s %s: issuer must not be called, calls=%d", rt.name, x, c)
			}
		}
	}
	t.Logf("examined %d route x body combinations", n)
}
