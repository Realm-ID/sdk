package realmid

import (
	ctxpkg "context"
	"errors"
	"net/http"
	"os"
	"testing"
)

// readSDKSource is shared by the tests that assert on a doc comment (a doc
// comment can be the only safety control a pure function has).
func readSDKSource(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(b)
}

func TestProxyStatus_Nil(t *testing.T) {
	status, code, details := ProxyStatus(nil)
	if status != 0 || code != "" || details != nil {
		t.Errorf("ProxyStatus(nil) = (%d, %q, %v), want (0, \"\", nil)", status, code, details)
	}
}

func TestProxyStatus_PassesTheUpstreamStatusAndCodeThrough(t *testing.T) {
	err := &RealmError{Code: ErrCodeForbidden, Message: "nope", HTTPStatus: http.StatusForbidden}
	status, code, details := ProxyStatus(err)
	if status != http.StatusForbidden {
		t.Errorf("status = %d, want 403", status)
	}
	if code != "forbidden" {
		t.Errorf("code = %q, want forbidden", code)
	}
	if details != nil {
		t.Errorf("details = %v, want nil", details)
	}
}

func TestProxyStatus_PreservesGatePayloadDetails(t *testing.T) {
	// THE non-obvious rule: without this the BFF flattens the upstream envelope
	// to {code,message} and the SPA's SessionLimitModal / MfaPrompt have
	// nothing to act on.
	for _, tc := range []struct {
		name string
		code ErrorCode
		key  string
	}{
		{"session limit", ErrCodeSessionLimitReached, "revocation_token"},
		{"mfa gate", ErrCodeMFARequired, "mfa_challenge_token"},
		{"mfa enrollment", ErrCodeMFARegistrationRequired, "mfa_challenge_token"},
	} {
		err := &RealmError{
			Code:       tc.code,
			HTTPStatus: http.StatusPreconditionFailed,
			Details:    map[string]any{tc.key: "tok-123", "tenant_id": "t-1"},
		}
		status, code, details := ProxyStatus(err)
		if status != http.StatusPreconditionFailed {
			t.Errorf("%s: status = %d, want 412", tc.name, status)
		}
		if code != string(tc.code) {
			t.Errorf("%s: code = %q, want %q", tc.name, code, tc.code)
		}
		if details == nil {
			t.Fatalf("%s: details dropped — the SPA gate cannot proceed", tc.name)
		}
		if got, _ := details[tc.key].(string); got != "tok-123" {
			t.Errorf("%s: details[%s] = %v, want tok-123", tc.name, tc.key, details[tc.key])
		}
		if got, _ := details["tenant_id"].(string); got != "t-1" {
			t.Errorf("%s: details[tenant_id] dropped", tc.name)
		}
	}
}

func TestProxyStatus_WrappedRealmErrorIsStillFound(t *testing.T) {
	inner := &RealmError{Code: ErrCodeNotFound, HTTPStatus: http.StatusNotFound}
	status, code, _ := ProxyStatus(errors.Join(errors.New("role not found"), inner))
	if status != http.StatusNotFound || code != "not_found" {
		t.Errorf("wrapped RealmError = (%d, %q), want (404, not_found)", status, code)
	}
}

func TestProxyStatus_StatuslessRealmErrorBecomes500(t *testing.T) {
	status, code, _ := ProxyStatus(&RealmError{Code: ErrCodeServerError})
	if status != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", status)
	}
	if code != "server_error" {
		t.Errorf("code = %q, want server_error", code)
	}
}

func TestProxyStatus_TimeoutIs504(t *testing.T) {
	// A context cut before the issuer replied is OUR timeout, not the issuer
	// saying no — 504, never 500, and never the issuer's status.
	for name, base := range map[string]error{
		"deadline": ctxpkg.DeadlineExceeded,
		"canceled": ctxpkg.Canceled,
	} {
		status, code, _ := ProxyStatus(base)
		if status != http.StatusGatewayTimeout {
			t.Errorf("%s: status = %d, want 504", name, status)
		}
		if code != ProxyCodeUpstreamTimeout {
			t.Errorf("%s: code = %q, want %q", name, code, ProxyCodeUpstreamTimeout)
		}
	}
}

func TestProxyStatus_TimeoutWrappedInARealmErrorIsStill504(t *testing.T) {
	// The SDK's own transport wraps a cut context as
	// &RealmError{Code: network, Cause: ctx.Err()} with NO HTTPStatus. Reading
	// that as a plain RealmError yields 500, which is a lie: nothing upstream
	// ever answered. Timeout is classified FIRST.
	err := &RealmError{Code: ErrCodeNetwork, Message: "network error", Cause: ctxpkg.DeadlineExceeded}
	status, code, _ := ProxyStatus(err)
	if status != http.StatusGatewayTimeout {
		t.Errorf("status = %d, want 504 for a cut context wrapped by the SDK transport", status)
	}
	if code != ProxyCodeUpstreamTimeout {
		t.Errorf("code = %q, want %q", code, ProxyCodeUpstreamTimeout)
	}
}

func TestProxyStatus_UnknownErrorIs502(t *testing.T) {
	status, code, details := ProxyStatus(errors.New("dial tcp: no route to host"))
	if status != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", status)
	}
	if code != "" {
		t.Errorf("code = %q, want \"\" so the caller supplies its own default", code)
	}
	if details != nil {
		t.Errorf("details = %v, want nil", details)
	}
}
