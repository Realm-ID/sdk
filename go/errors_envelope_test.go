package realmid

import (
	"net/http"
	"testing"
)

// A4-go: the two error-envelope shapes a proxy has to read off a raw issuer
// response body. See reference_issuer_error_envelope_shapes — the coded
// `{error:{code,message}}` form and the CODE-LESS GoFr middleware 401 are
// different shapes, and a retry guard matching only one is the recurring bug.

func TestParseErrorEnvelope_NestedCodedEnvelope(t *testing.T) {
	// The shape the issuer actually emits for a role-specific refusal: a
	// canonical code inside `error`, and the SPECIFIC code beside it at the top
	// level. Both must survive — role_owner_only is not in the canonical
	// ErrorCode union, so Details is the only place it can live, and it is
	// where detailCode/mapRoleErr already look.
	body := []byte(`{"error":{"code":"forbidden","message":"only the organisation owner may grant that role"},` +
		`"code":"role_owner_only"}`)
	re := ParseErrorEnvelope(body, http.StatusForbidden)
	if re.HTTPStatus != http.StatusForbidden {
		t.Errorf("HTTPStatus = %d, want 403", re.HTTPStatus)
	}
	if re.Code != ErrCodeForbidden {
		t.Errorf("Code = %q, want forbidden", re.Code)
	}
	if re.Message != "only the organisation owner may grant that role" {
		t.Errorf("Message = %q", re.Message)
	}
	if got, _ := re.Details["code"].(string); got != "role_owner_only" {
		t.Errorf("specific code lost: Details = %v", re.Details)
	}
	if got := detailCode(re); got != "role_owner_only" {
		t.Errorf("detailCode(re) = %q — the sentinel mappers cannot see the specific code", got)
	}
}

func TestParseErrorEnvelope_KnownCodeLandsOnCode(t *testing.T) {
	body := []byte(`{"error":{"code":"mfa_required","message":"step up","mfa_challenge_token":"ct-1"},"tenant_id":"t-1"}`)
	re := ParseErrorEnvelope(body, http.StatusPreconditionFailed)
	if re.Code != ErrCodeMFARequired {
		t.Errorf("Code = %q, want mfa_required", re.Code)
	}
	// Gate payloads nested INSIDE the error object must survive, alongside the
	// siblings next to it.
	if got, _ := re.Details["mfa_challenge_token"].(string); got != "ct-1" {
		t.Errorf("mfa_challenge_token dropped: %v", re.Details)
	}
	if got, _ := re.Details["tenant_id"].(string); got != "t-1" {
		t.Errorf("tenant_id sibling dropped: %v", re.Details)
	}
}

func TestParseErrorEnvelope_FlatIssuerEnvelope(t *testing.T) {
	// The issuer's apiErr.Response(): `error` is a STRING and `code` sits
	// beside it at the top level.
	body := []byte(`{"error":"refresh token reuse detected","code":"refresh_invalid"}`)
	re := ParseErrorEnvelope(body, http.StatusUnauthorized)
	if re.Code != ErrCodeRefreshInvalid {
		t.Errorf("Code = %q, want refresh_invalid", re.Code)
	}
	if re.Message != "refresh token reuse detected" {
		t.Errorf("Message = %q", re.Message)
	}
}

func TestParseErrorEnvelope_CodelessGoFrMiddleware401(t *testing.T) {
	// The other shape: GoFr's own auth middleware rejects a bad Authorization
	// bearer BEFORE any handler runs, so there is no `code` at all. A guard
	// that branches on a code sees nothing here — the STATUS is the signal.
	body := []byte(`{"error":"invalid Authorization header"}`)
	re := ParseErrorEnvelope(body, http.StatusUnauthorized)
	if re.Code != ErrCodeUnauthorized {
		t.Errorf("Code = %q, want the status-derived unauthorized", re.Code)
	}
	if re.HTTPStatus != http.StatusUnauthorized {
		t.Errorf("HTTPStatus = %d, want 401", re.HTTPStatus)
	}
	if re.Message != "invalid Authorization header" {
		t.Errorf("Message = %q", re.Message)
	}
}

func TestParseErrorEnvelope_UnparseableBodyNeverLeaksRaw(t *testing.T) {
	// RCA 2026-07-01: the raw JSON body leaked into the SPA error banners.
	// A body we cannot read yields a generic status message, never the bytes.
	for name, body := range map[string][]byte{
		"empty":     nil,
		"html":      []byte("<html>502 Bad Gateway</html>"),
		"bare json": []byte(`"just a string"`),
	} {
		re := ParseErrorEnvelope(body, http.StatusBadGateway)
		if re.HTTPStatus != http.StatusBadGateway {
			t.Errorf("%s: HTTPStatus = %d, want 502", name, re.HTTPStatus)
		}
		if re.Message == "" {
			t.Errorf("%s: Message is empty; a caller has nothing to show", name)
		}
		if re.Message == string(body) && len(body) > 0 {
			t.Errorf("%s: the raw body leaked into Message", name)
		}
		if re.Code != ErrCodeServerError {
			t.Errorf("%s: Code = %q, want the status fallback", name, re.Code)
		}
	}
}

func TestParseErrorEnvelope_MessageIsStatusTextWhenTheBodySaysNothing(t *testing.T) {
	re := ParseErrorEnvelope([]byte(`{}`), http.StatusNotFound)
	if re.Message != http.StatusText(http.StatusNotFound) {
		t.Errorf("Message = %q, want %q", re.Message, http.StatusText(http.StatusNotFound))
	}
	if re.Code != ErrCodeNotFound {
		t.Errorf("Code = %q, want not_found", re.Code)
	}
}

func TestParseErrorEnvelope_UnknownStatusStillGetsAMessage(t *testing.T) {
	re := ParseErrorEnvelope(nil, 599)
	if re.Message == "" {
		t.Errorf("a status with no http.StatusText must still yield a message")
	}
}

// The typed client path must keep behaving exactly as before the shared helper
// was extracted: its message names the method and path.
func TestMapErrorResponse_StillNamesMethodAndPath(t *testing.T) {
	re := mapErrorResponse(http.StatusInternalServerError, []byte(`{}`), "GET", "/platforms/p1/roles")
	if re.Message != "GET /platforms/p1/roles failed with HTTP 500" {
		t.Errorf("Message = %q — the typed-client fallback message changed", re.Message)
	}
}
