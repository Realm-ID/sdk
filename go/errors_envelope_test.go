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
	if got, _ := re.Details["server_code"].(string); got != "role_owner_only" {
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

// The DEFECT this test was written against (found independently by the W1a and
// W3 agents, 2026-08-30): on the NESTED shape the sibling sweep skipped the key
// `code` unconditionally, so a code outside the canonical ErrorCode union was
// neither carried on Code nor preserved in Details — it vanished. ADR-101's own
// 403, `role_owner_only`, collapsed to a plain `forbidden` for every SDK
// consumer, and the reference BFF only survived it by re-reading the body
// itself. The doc comment already promised Details["code"].
func TestParseErrorEnvelope_NestedUncanonicalCodeSurvives(t *testing.T) {
	// The shape GoFr renders around the issuer's apiErr for ADR-101 D6.
	body := []byte(`{"error":{"code":"role_owner_only","message":"only the owner may seat this role"}}`)
	re := ParseErrorEnvelope(body, http.StatusForbidden)
	if re.Code != ErrCodeForbidden {
		t.Errorf("Code = %q, want the status-derived forbidden", re.Code)
	}
	if re.Message != "only the owner may seat this role" {
		t.Errorf("Message = %q", re.Message)
	}
	if got, _ := re.Details["server_code"].(string); got != "role_owner_only" {
		t.Errorf("nested uncanonical code lost: Details = %v", re.Details)
	}
	if got := detailCode(re); got != "role_owner_only" {
		t.Errorf("detailCode(re) = %q — the sentinel mappers cannot see the specific code", got)
	}
}

func TestParseErrorEnvelope_FlatUncanonicalCodeSurvives(t *testing.T) {
	// Same rule on the flat apiErr.Response() shape: the top-level `code` was
	// skipped from the sibling sweep too.
	body := []byte(`{"error":"only the owner may seat this role","code":"role_owner_only"}`)
	re := ParseErrorEnvelope(body, http.StatusForbidden)
	if re.Code != ErrCodeForbidden {
		t.Errorf("Code = %q, want forbidden", re.Code)
	}
	if got, _ := re.Details["server_code"].(string); got != "role_owner_only" {
		t.Errorf("flat uncanonical code lost: Details = %v", re.Details)
	}
}

func TestParseErrorEnvelope_NestedLegacyErrorStringIsTheMessage(t *testing.T) {
	// Some issuer refusals render `{"error":{"code":…,"error":"<msg>"}}` with no
	// `message` key at all. Reading only `message` there produced the bare
	// status text ("Forbidden") in the SPA's banner.
	body := []byte(`{"error":{"code":"forbidden","error":"not the tenant owner"}}`)
	re := ParseErrorEnvelope(body, http.StatusForbidden)
	if re.Message != "not the tenant owner" {
		t.Errorf("Message = %q, want the nested legacy error string", re.Message)
	}
}

func TestParseErrorEnvelope_TopLevelCodeOutranksTheNestedOne(t *testing.T) {
	// When both are stated the OUTER one is the specific refusal (this is the
	// shape TestParseErrorEnvelope_NestedCodedEnvelope covers); preserving the
	// nested one must not overwrite it.
	body := []byte(`{"error":{"code":"role_owner_only","message":"m"},"code":"role_seating_denied"}`)
	re := ParseErrorEnvelope(body, http.StatusForbidden)
	if got, _ := re.Details["server_code"].(string); got != "role_seating_denied" {
		t.Errorf("Details[server_code] = %q, want the top-level code to win", got)
	}
}

func TestParseErrorEnvelope_CanonicalCodeIsNotAlsoCopiedIntoDetails(t *testing.T) {
	// The other half of the preservation rule, and a mutation of the fix
	// survived without it: a code the union DID carry stays on Code alone.
	// Copying it into Details too would make detailCode() start answering for
	// every canonical refusal, changing what the existing sentinel mappers
	// match on.
	body := []byte(`{"error":{"code":"mfa_required","message":"step up"}}`)
	re := ParseErrorEnvelope(body, http.StatusPreconditionFailed)
	if re.Code != ErrCodeMFARequired {
		t.Errorf("Code = %q, want mfa_required", re.Code)
	}
	if got, ok := re.Details["server_code"]; ok {
		t.Errorf("Details[server_code] = %v — a canonical code must not be duplicated into Details", got)
	}
	if got := detailCode(re); got != "" {
		t.Errorf("detailCode(re) = %q, want empty", got)
	}
}

// StatedErrorCode is the other half a proxy needs, and the half that kept the
// BFF's `envelopeStated` alive: ParseErrorEnvelope NARROWS, so a canonical
// stated code is indistinguishable on Code from one derived from the status,
// and a proxy that must answer "the upstream stated no code" cannot tell them
// apart. It reads the body verbatim and narrows nothing.
func TestStatedErrorCode(t *testing.T) {
	cases := map[string]struct {
		body string
		want string
	}{
		"nested canonical":                {`{"error":{"code":"forbidden","message":"m"}}`, "forbidden"},
		"nested uncanonical":              {`{"error":{"code":"role_owner_only","message":"m"}}`, "role_owner_only"},
		"top level outranks nested":       {`{"error":{"code":"forbidden","message":"m"},"code":"role_owner_only"}`, "role_owner_only"},
		"flat":                            {`{"error":"m","code":"refresh_invalid"}`, "refresh_invalid"},
		"top-level code and message":      {`{"code":"rate_limited","message":"slow down"}`, "rate_limited"},
		"code-less GoFr middleware":       {`{"error":{"message":"invalid authorization header"}}`, ""},
		"code-less flat":                  {`{"error":"Unauthenticated"}`, ""},
		"empty body":                      {``, ""},
		"html from a load balancer":       {`<html>502 Bad Gateway</html>`, ""},
		"a non-string code is not a code": {`{"error":{"code":404}}`, ""},
	}
	for name, c := range cases {
		if got := StatedErrorCode([]byte(c.body)); got != c.want {
			t.Errorf("%s: StatedErrorCode = %q, want %q", name, got, c.want)
		}
	}
}

// The KEY the preserved code lands under is CONTRACT, and it is `server_code`
// in all three SDKs (SPEC.md §3.3). It was `code` here and `server_code` in
// ts/java until 2026-08-30, so a partner porting a branch from the TypeScript
// SDK to Go read an absent key and silently fell back to the generic status
// code. `server_code` won on evidence, not taste: SPEC.md named neither, and
// `server_code` is the only one of the two already read by SHIPPED consumers
// (`web/packages/admin/src/errors.ts`, `web/packages/core/src/memberships.ts`,
// `ui/web/src/{Sources,ServiceAccounts}.tsx`), while this Go write had never
// been released — it sat under `## Unreleased` when the divergence was settled.
func TestParseErrorEnvelope_PreservedCodeKeyIsServerCode(t *testing.T) {
	// Nested-only: nothing states `code` at the top level, so `code` must not
	// appear in Details at all. Anything reading Details["code"] here is
	// reading a key this SDK no longer writes.
	body := []byte(`{"error":{"code":"role_owner_only","message":"only the owner may seat this role"}}`)
	re := ParseErrorEnvelope(body, http.StatusForbidden)
	if got, _ := re.Details["server_code"].(string); got != "role_owner_only" {
		t.Errorf(`Details["server_code"] = %q, want role_owner_only — Details = %v`, got, re.Details)
	}
	if got, ok := re.Details["code"]; ok {
		t.Errorf(`Details["code"] = %v — the preserved code moved to server_code; nothing states a top-level code here`, got)
	}
}

// A body that LITERALLY states a `server_code` sibling keeps it: preservation
// is putIfAbsent, never an overwrite. Same rule java's transport applies.
func TestParseErrorEnvelope_VerbatimServerCodeSiblingWins(t *testing.T) {
	body := []byte(`{"error":{"code":"role_owner_only","message":"m"},"server_code":"from_the_wire"}`)
	re := ParseErrorEnvelope(body, http.StatusForbidden)
	if got, _ := re.Details["server_code"].(string); got != "from_the_wire" {
		t.Errorf(`Details["server_code"] = %q, want the verbatim sibling`, got)
	}
}

// ITEM 2 parity anchor: the REAL step-up gate body. GoFr renders the issuer's
// apiErr merged map UNDER `error` (`createErrorResponse` +
// `response{Error: …}`), so every sibling mfaGateError.Response() adds —
// mfa_challenge_token, methods, reason, max_age_seconds — arrives INSIDE the
// error object, not beside it. A parser collecting only top-level siblings
// hands the caller an empty details map and a step-up prompt with no token to
// answer. ts + java both did exactly that until 2026-08-30.
func TestParseErrorEnvelope_NestedGatePayloadIsTheIssuerShape(t *testing.T) {
	body := []byte(`{"error":{"code":"mfa_required","message":"this operation requires a fresh MFA proof",` +
		`"mfa_challenge_token":"chal-xyz","methods":["totp"],"reason":"stale_mfa","max_age_seconds":300}}`)
	re := ParseErrorEnvelope(body, http.StatusPreconditionFailed)
	if re.Code != ErrCodeMFARequired {
		t.Errorf("Code = %q, want mfa_required", re.Code)
	}
	if got, _ := re.Details["mfa_challenge_token"].(string); got != "chal-xyz" {
		t.Errorf("mfa_challenge_token dropped: Details = %v", re.Details)
	}
	if got, _ := re.Details["reason"].(string); got != "stale_mfa" {
		t.Errorf("reason dropped: Details = %v", re.Details)
	}
	if got, _ := re.Details["max_age_seconds"].(float64); got != 300 {
		t.Errorf("max_age_seconds dropped: Details = %v", re.Details)
	}
}
