package realmid

import (
	"errors"
	"testing"
)

// The issuer's two 410 suspension refusals (partner request, Traide 2026-10-30):
// realm_suspended (issuer auth.go, oidc.go, jwks.go, ...) and tenant_suspended
// (integration_mint_handler.go, integration_installations.go). Distinct from the
// 403 tenant_disabled, which is a bearer-request refusal.
const (
	realmSuspendedBody  = `{"error":{"code":"realm_suspended","error":"realm is suspended","message":"realm is suspended"}}`
	tenantSuspendedBody = `{"error":{"code":"tenant_suspended","error":"tenant is not active","message":"tenant is not active"}}`
	otpExpiredBody      = `{"error":{"code":"otp_expired","error":"code expired","message":"code expired"}}`
)

func TestGoneSuspendedCodes_RegisteredAndPredicates(t *testing.T) {
	if !isKnownCode("realm_suspended") || !isKnownCode("tenant_suspended") {
		t.Fatal("realm_suspended / tenant_suspended must be in knownCodes")
	}
	for _, tc := range []struct {
		name string
		body string
		code ErrorCode
		is   func(error) bool
		not  func(error) bool
	}{
		{"realm", realmSuspendedBody, ErrCodeRealmSuspended, IsRealmSuspended, IsTenantSuspended},
		{"tenant", tenantSuspendedBody, ErrCodeTenantSuspended, IsTenantSuspended, IsRealmSuspended},
	} {
		parsed := ParseErrorEnvelope([]byte(tc.body), 410)
		if parsed.Code != tc.code {
			t.Fatalf("%s: 410 body parsed to Code %q, want %q", tc.name, parsed.Code, tc.code)
		}
		if parsed.HTTPStatus != 410 {
			t.Errorf("%s: HTTPStatus %d, want 410", tc.name, parsed.HTTPStatus)
		}
		wrapped := errors.Join(errors.New("ctx"), parsed)
		if !tc.is(wrapped) || tc.not(wrapped) {
			t.Errorf("%s: predicate must match exactly this code", tc.name)
		}
		if tc.is(ParseErrorEnvelope([]byte(otpExpiredBody), 410)) {
			t.Errorf("%s: predicate true for another 410 (otp_expired)", tc.name)
		}
		if IsTenantDisabled(parsed) {
			t.Errorf("%s: must not read as the 403 tenant_disabled", tc.name)
		}
	}
	if IsRealmSuspended(nil) || IsTenantSuspended(nil) ||
		IsRealmSuspended(errors.New("x")) || IsTenantSuspended(errors.New("x")) {
		t.Error("nil / foreign error must be false")
	}
}
