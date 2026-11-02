package realmid

// RED tests: the twelve device-authorization codes of SPEC §3.1 are registered (SPEC §15, Q8).
// String-keyed on purpose so the file compiles before the ErrCode constants exist.

import (
	"errors"
	"net/http"
	"testing"
)

var deviceCodes = []struct {
	code   string
	status int
}{
	{"authorization_pending", 400}, {"slow_down", 400}, {"access_denied", 400}, {"expired_token", 400},
	{"device_code_attempts_exceeded", 429}, {"subject_suspended", 409}, {"device_authorization_not_pending", 409},
	{"device_authorization_collected", 409}, {"revoke_existing_sessions_required", 400}, {"invalid_client_id", 400},
	{"tenant_not_member", 400}, {"device_approval_not_allowed", 403},
}

func TestDeviceCodesAreRegisteredAndSurviveMapping(t *testing.T) {
	for _, c := range deviceCodes {
		t.Run(c.code, func(t *testing.T) {
			if !isKnownCode(c.code) {
				t.Fatalf("%s is not in knownCodes: it collapses into the HTTP-status fallback", c.code)
			}
			re := mapErrorResponse(c.status, []byte(`{"error":{"code":"`+c.code+`","message":"m"}}`), "POST", "/auth/token")
			if string(re.Code) != c.code {
				t.Errorf("mapped code = %q, want %q", re.Code, c.code)
			}
		})
	}
}

func TestDeviceApprovalNotAllowedIsATypedError(t *testing.T) {
	re := mapErrorResponse(http.StatusForbidden, []byte(`{"error":{"code":"device_approval_not_allowed","message":"m"}}`), "POST", "/device/approve")
	if !errors.Is(re, ErrDeviceApprovalNotAllowed) {
		t.Errorf("the decoder must carry ErrDeviceApprovalNotAllowed in RealmError.Cause (R86); err = %v", re)
	}
}
