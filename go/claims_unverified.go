package realmid

import (
	"encoding/base64"
	"encoding/json"
	"strings"
)

// ParseClaimsUnverified decodes a JWT's payload WITHOUT checking its signature,
// its issuer, its audience, or its expiry.
//
// ⚠️ UNVERIFIED — DO NOT TRUST THE RESULT FOR AUTHORIZATION. Nothing here
// proves the token is genuine, unexpired, or meant for you. Anyone who can hand
// you a string can choose every field it returns. For an authorization
// decision, use Realm.Verifier().Verify, which checks the RS256 signature
// against the realm's JWKS and enforces iss/aud/exp/nbf.
//
// It exists for the ONE case where the check is redundant because of
// PROVENANCE, not convenience: a BFF reading a claim off a token it holds
// sealed server-side (the ADR-060 pattern). That token was minted by the
// issuer, delivered to this process over TLS, and has never been client-
// supplied — a client that could substitute it could substitute the whole
// session record. Typical reads are `sub` (which user does this session belong
// to) and `mfa_at` (SPEC §10.4 step-up freshness).
//
// FAILS TO ZERO VALUE. Any malformed input — wrong part count, bad base64, a
// payload that is not a JSON object — returns (nil, *RealmError{malformed})
// rather than partial claims. Callers keep whatever they already had instead of
// clobbering it with garbage, and a step-up gate reading a zero `mfa_at` sees
// "no proof" and fails closed.
func ParseClaimsUnverified(token string) (*Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, newErr(ErrCodeMalformed, "expected 3 dot-separated parts")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, newErr(ErrCodeMalformed, "payload b64: %v", err)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(payload, &raw); err != nil {
		return nil, newErr(ErrCodeMalformed, "payload json: %v", err)
	}
	claims := &Claims{}
	if err := json.Unmarshal(payload, claims); err != nil {
		return nil, newErr(ErrCodeMalformed, "claims json: %v", err)
	}
	// Same non-reserved sweep the verifier does, so a caller reading Extra sees
	// the same shape on both paths.
	for k, val := range raw {
		if _, reserved := reservedClaimKeys[k]; reserved {
			continue
		}
		var x any
		if err := json.Unmarshal(val, &x); err != nil {
			continue
		}
		if claims.Extra == nil {
			claims.Extra = make(map[string]any)
		}
		claims.Extra[k] = x
	}
	return claims, nil
}
