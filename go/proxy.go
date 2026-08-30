package realmid

import "net/http"

// ProxyCodeUpstreamTimeout is the code ProxyStatus returns when the request
// context was cut before the issuer answered. It is deliberately distinct from
// any issuer code: nothing upstream said no, we gave up.
const ProxyCodeUpstreamTimeout = "upstream_timeout"

// ProxyStatus classifies an SDK error into the HTTP status, error code and
// detail payload a BFF should relay to its own client.
//
// Every partner BFF fronting the issuer needs exactly this, and getting it
// wrong breaks the SPA's gates SILENTLY — the call fails, the modal never
// opens, and the user sees a dead button. The three non-obvious rules:
//
//  1. DETAILS ARE PRESERVED. The issuer nests gate payloads inside the error
//     envelope: `revocation_token` + `active_sessions` on a
//     `session_limit_reached` 412, `mfa_challenge_token` + `tenant_id` on the
//     two MFA gates. A BFF that flattens the envelope to {code,message} leaves
//     the session-limit modal and the MFA prompt with nothing to act on.
//  2. A TIMEOUT IS 504, and it is classified FIRST. The SDK's own transport
//     wraps a cut context as a *RealmError with code `network` and NO HTTP
//     status, so reading it as a plain RealmError yields 500 — a lie, because
//     nothing upstream ever answered. Checking IsTimeout before the RealmError
//     branch is what makes the documented 504 reachable.
//  3. AN UNRECOGNISED ERROR IS 502, not 500. We are a proxy; a failure we
//     cannot classify happened between us and the issuer.
//
// Returns:
//
//	status  — the HTTP status to send. 0 when err is nil.
//	code    — the machine-readable code. EMPTY when the error carries none
//	          (the unclassified 502, and a *RealmError with no Code); supply
//	          your own per-operation default in that case.
//	details — the envelope siblings, or nil. Relay them verbatim.
//
// Wrapping the result in a framework-specific error type is the caller's job:
// GoFr's `ApiErr` — or whatever your BFF renders — is not the SDK's business.
// Only the classification lives here.
func ProxyStatus(err error) (status int, code string, details map[string]any) {
	if err == nil {
		return 0, "", nil
	}
	if IsTimeout(err) {
		return http.StatusGatewayTimeout, ProxyCodeUpstreamTimeout, nil
	}
	var re *RealmError
	if AsRealmError(err, &re) {
		status = re.HTTPStatus
		if status == 0 {
			status = http.StatusInternalServerError
		}
		return status, string(re.Code), re.Details
	}
	return http.StatusBadGateway, "", nil
}
