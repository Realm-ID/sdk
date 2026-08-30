package realmid

import "net/http"

// ParseErrorEnvelope reads an issuer error RESPONSE BODY into a *RealmError.
//
// The typed clients do this for you. This is for the code that does not go
// through them — a BFF proxying a raw upstream response, or a fan-out handler
// that reads several issuer replies and renders a per-section error block. Both
// used to hand-roll it, and both got it subtly wrong.
//
// THERE ARE TWO ENVELOPE SHAPES and a guard that matches only one silently
// stops matching:
//
//   - The CODED envelope a handler emits — `{"error":{"code","message",…}}`, or
//     the flat `{"error":"<message>","code":"<code>"}` form the issuer's own
//     apiErr.Response() writes. Gate payloads (`mfa_challenge_token`,
//     `revocation_token`, `tenant_id`, …) ride alongside or inside the error
//     object; both are collected into Details.
//   - The CODE-LESS one. GoFr's framework middleware rejects a malformed
//     `Authorization` bearer BEFORE any handler runs, so its 401 carries no
//     `code` at all — only a message. Branch on HTTPStatus there, not on Code.
//     (A bad `X-User-Token`, by contrast, IS coded: `x_user_token_invalid`.)
//
// A code that is not in the SDK's canonical ErrorCode union does not vanish: it
// stays in Details["code"], which is where the role/service-account mappers
// already look. An unparseable body — HTML from a load balancer, an empty
// response — yields the status-derived code and a generic message, NEVER the
// raw bytes: leaking the body into a message is how JSON ended up rendered in
// the SPA's error banners (RCA 2026-07-01).
//
// Always returns a non-nil *RealmError; `status` is carried through on
// HTTPStatus so a caller can relay it (see ProxyStatus).
func ParseErrorEnvelope(body []byte, status int) *RealmError {
	fallback := http.StatusText(status)
	if fallback == "" {
		fallback = "upstream request failed"
	}
	return errorFromEnvelope(status, body, fallback)
}
