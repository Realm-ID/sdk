package realmid

// ADR-096 D4 on the device approve step-up: an approver with no confirmed factor is answered
// 412 mfa_registration_required (an ENROLL state), never a verify challenge with an empty token.

import (
	"net/http"
	"testing"
)

func TestDevice_ApproveStepUpAnswersRegistrationRequiredWithNoFactor(t *testing.T) {
	d := approveIssuer(t)
	d.reply("/auth/mfa/authenticators", 200, map[string]any{"authenticators": []any{}, "backup_codes_remaining": 0})
	s := mustSet(t, d.realm(t, nil), baseDeviceOpts())
	stale := &Claims{Subject: "u1", TenantID: "t1", SessionID: "s1"}
	w := browserCall(s.Approve, map[string]any{"userCode": "ABCD-EFGH", "revokeExistingSessions": true}, stale)
	if w.Code != http.StatusPreconditionFailed || errCode(decode(t, w)) != "mfa_registration_required" {
		t.Errorf("status %d body %s, want 412 mfa_registration_required", w.Code, w.Body.String())
	}
	if n := len(d.at(pApprove)); n != 0 {
		t.Errorf("issuer approve called %d times", n)
	}
	if got := d.at("/auth/mfa/challenge"); len(got) != 0 {
		t.Errorf("a verify challenge was minted for a person with nothing to verify: %d calls", len(got))
	}
}

func TestDevice_ApproveStepUpStaysAVerifyChallengeWithAConfirmedFactor(t *testing.T) {
	d := approveIssuer(t)
	d.reply("/auth/mfa/authenticators", 200, map[string]any{"authenticators": []any{map[string]any{"type": "totp", "confirmed": true}}})
	d.reply("/auth/mfa/challenge", 200, map[string]any{"mfa_challenge_token": "ct1", "methods": []string{"totp"}})
	s := mustSet(t, d.realm(t, nil), baseDeviceOpts())
	stale := &Claims{Subject: "u1", TenantID: "t1", SessionID: "s1"}
	w := browserCall(s.Approve, map[string]any{"userCode": "ABCD-EFGH", "revokeExistingSessions": true}, stale)
	m := decode(t, w)
	if w.Code != http.StatusPreconditionFailed || errCode(m) != "mfa_required" || m["mfa_challenge_token"] != "ct1" {
		t.Errorf("status %d body %s, want 412 mfa_required with ct1", w.Code, w.Body.String())
	}
}
