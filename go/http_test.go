package realmid

import "testing"

// TestMapErrorResponse_NestedGateDetails locks the fix for the dropped gate
// payload: the issuer nests gate siblings (revocation_token, active_sessions,
// mfa_challenge_token) INSIDE the error object, not alongside it. The parser
// must surface them on RealmError.Details so SessionLimitModal / MfaPrompt have
// something to act on.
func TestMapErrorResponse_NestedGateDetails(t *testing.T) {
	body := []byte(`{"error":{"code":"session_limit_reached","message":"concurrent session limit reached","revocation_token":"rk.tok","active_sessions":[{"id":"s1","created_at":1}]}}`)
	re := mapErrorResponse(412, body, "POST", "/auth/login")

	if re.Code != ErrCodeSessionLimitReached {
		t.Fatalf("code = %q, want session_limit_reached", re.Code)
	}
	if re.Details == nil {
		t.Fatal("Details is nil; nested gate fields were dropped")
	}
	if got, _ := re.Details["revocation_token"].(string); got != "rk.tok" {
		t.Fatalf("Details[revocation_token] = %q, want rk.tok", got)
	}
	sess, ok := re.Details["active_sessions"].([]any)
	if !ok || len(sess) != 1 {
		t.Fatalf("Details[active_sessions] = %#v, want one entry", re.Details["active_sessions"])
	}
}

// TestMapErrorResponse_TopLevelSiblingsStillCollected guards the pre-existing
// behaviour: siblings placed alongside the error object are still collected.
func TestMapErrorResponse_TopLevelSiblingsStillCollected(t *testing.T) {
	body := []byte(`{"error":{"code":"mfa_required","message":"mfa"},"mfa_challenge_token":"ct"}`)
	re := mapErrorResponse(412, body, "POST", "/auth/token")
	if got, _ := re.Details["mfa_challenge_token"].(string); got != "ct" {
		t.Fatalf("Details[mfa_challenge_token] = %q, want ct", got)
	}
}
