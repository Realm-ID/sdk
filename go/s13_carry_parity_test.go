package realmid

// S13 (final parity review findings 1 and 2, 2026-11-14). Spec: sdk/SPEC.md
// SPEC4_2_carry_all rules 1-3 and its example "Second mint 401 refresh_invalid:
// 503 server_error, R1 set"; the carried 503 body carries `retry: true`
// (SPEC.md:1447-1449).

import (
	"strings"
	"testing"
)

func TestS13_SecondMint401IsCarriedAs503ServerError(t *testing.T) {
	for _, delivery := range []string{"", "body"} {
		h := secondMintEnv(t, delivery, 401, `{"error":{"code":"refresh_invalid","message":"dead"}}`, claimsOK)
		w := driveWith(h, "/token", delivery == "", `{"tenant_id":"t1","refresh_token":"rt-spent"}`)
		b := w.Body.String()
		if w.Code != 503 || !strings.Contains(b, `"code":"server_error"`) {
			t.Fatalf("delivery %q: status %d body %s, want 503 server_error", delivery, w.Code, b)
		}
		if !strings.Contains(b, `"retry":true`) {
			t.Errorf("delivery %q: carried body lacks retry:true: %s", delivery, b)
		}
		if delivery == "" && setCookie(w) != "R1" {
			t.Errorf("cookie mode lost R1: %q", setCookie(w))
		}
		if delivery == "body" && !strings.Contains(b, `"refresh_token":"R1"`) {
			t.Errorf("body mode lost R1: %s", b)
		}
	}
}

func TestS13_CarriedSameTenant503BodyHasRetry(t *testing.T) {
	h := secondMintEnv(t, "", 500, `{"error":{"code":"server_error","message":"x"}}`, claimsOK)
	w := driveWith(h, "/token", true, `{"tenant_id":"t1"}`)
	if !strings.Contains(w.Body.String(), `"retry":true`) {
		t.Fatalf("status %d body %s lacks retry:true", w.Code, w.Body.String())
	}
}
