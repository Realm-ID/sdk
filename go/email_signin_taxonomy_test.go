package realmid

// RED tests: the five codes of issuer ADR-123 (emailed sign-in codes) and ADR-124 (lockout guards)
// are registered (SPEC §3.1). String-keyed so the file compiles before the constants exist.

import "testing"

var emailSignInCodes = []struct {
	code   string
	status int
}{
	{"acknowledgement_required", 400}, {"email_otp_requires_identifying_email", 409},
	{"email_otp_rate_limited", 429}, {"last_browser_sign_in", 409}, {"last_machine_credential", 409},
}

func TestEmailSignInAndLockoutGuardCodesAreRegisteredAndSurviveMapping(t *testing.T) {
	for _, c := range emailSignInCodes {
		t.Run(c.code, func(t *testing.T) {
			if !isKnownCode(c.code) {
				t.Fatalf("%s is not in knownCodes: it collapses into the HTTP-status fallback", c.code)
			}
			re := mapErrorResponse(c.status, []byte(`{"error":{"code":"`+c.code+`","message":"m"}}`), "PATCH", "/platforms/p/config")
			if string(re.Code) != c.code {
				t.Errorf("mapped code = %q, want %q", re.Code, c.code)
			}
		})
	}
}
