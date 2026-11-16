package realmid

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// foldReservedNames is the SPEC §4.2 (SPEC4_2_claim_fold) reserved set: the
// issuer's reservedClaims plus `acr` (owner ruling 8, 2026-11-14). A drift test
// holds it to testdata/claim-fold-vectors/vectors.json.
var foldReservedNames = []string{
	"iss", "sub", "aud", "iat", "nbf", "exp", "jti", "azp", "tenant_id", "role",
	"mfa_at", "amr", "token_class", "scope", "product_roles", "sid", "events", "acr",
}

func isPrintableASCIIKey(k string) bool {
	if k == "" {
		return false
	}
	for i := 0; i < len(k); i++ {
		if k[i] < 0x20 || k[i] > 0x7e {
			return false
		}
	}
	return true
}

func foldReservedOf(k string) (string, bool) {
	f := asciiLower(k)
	for _, r := range foldReservedNames {
		if f == r {
			return r, true
		}
	}
	return "", false
}

// checkCustomClaimKey is SPEC §4.2 rule 1: a custom-claim key is non-empty,
// printable ASCII, and folds to no reserved name.
func checkCustomClaimKey(k string) error {
	if !isPrintableASCIIKey(k) {
		return fmt.Errorf("claim key %q is not non-empty printable ASCII", k)
	}
	if r, ok := foldReservedOf(k); ok {
		return fmt.Errorf("claim key %q collides with reserved claim %q", k, r)
	}
	return nil
}

// checkClaimFold is SPEC §4.2 rule 2 on a JWT payload: among the TOP-LEVEL
// keys (after JSON unescaping, read with a duplicate-preserving tokenizer,
// never a decoded map) refuse a non-printable-ASCII key, two keys with equal
// folds (exact duplicates included), and a key that is not byte-equal to a
// reserved name but folds to one.
func checkClaimFold(payload []byte) error {
	dec := json.NewDecoder(bytes.NewReader(payload))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return fmt.Errorf("payload is not a JSON object")
	}
	seen := map[string]string{}
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return err
		}
		k, ok := t.(string)
		if !ok {
			return fmt.Errorf("payload key is not a string")
		}
		if !isPrintableASCIIKey(k) {
			return fmt.Errorf("claim key %q is not non-empty printable ASCII", k)
		}
		f := asciiLower(k)
		if prev, dup := seen[f]; dup {
			return fmt.Errorf("claim keys %q and %q fold together", prev, k)
		}
		seen[f] = k
		if r, res := foldReservedOf(k); res && k != r {
			return fmt.Errorf("claim key %q folds to reserved claim %q", k, r)
		}
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return err
		}
	}
	return nil
}

// Claims is the verified token payload. Standard JWT fields plus the
// RealmID-specific extras (azp, tenant_id, role). Unknown fields land in
// Extra.
type Claims struct {
	Issuer    string `json:"iss,omitempty"`
	Subject   string `json:"sub,omitempty"`
	Audience  string `json:"aud,omitempty"`
	IssuedAt  int64  `json:"iat,omitempty"`
	NotBefore int64  `json:"nbf,omitempty"`
	Expiry    int64  `json:"exp,omitempty"`
	JWTID     string `json:"jti,omitempty"`
	// SessionID is the `sid` claim: the RealmID session this token belongs to
	// (SPEC §6.7.1). Absent from issuers older than Issuer A.
	SessionID       string   `json:"sid,omitempty"`
	AuthorizedParty string   `json:"azp,omitempty"`
	TenantID        string   `json:"tenant_id,omitempty"`
	Role            string   `json:"role,omitempty"`
	AMR             []string `json:"amr,omitempty"`
	ACR             string   `json:"acr,omitempty"`
	// MFAAt is the unix-seconds timestamp of the user's most recent
	// successful MFA challenge in this session. Zero means absent — the
	// session never completed MFA, or the server hasn't been upgraded
	// yet to emit this claim. SPEC §10.4.
	MFAAt int64          `json:"mfa_at,omitempty"`
	Extra map[string]any `json:"-"`
}

// reservedClaimKeys must stay in sync with the Claims struct fields above.
var reservedClaimKeys = map[string]struct{}{
	"iss": {}, "sub": {}, "aud": {}, "iat": {}, "nbf": {}, "exp": {},
	"jti": {}, "sid": {}, "azp": {}, "tenant_id": {}, "role": {}, "amr": {}, "acr": {},
	"mfa_at": {},
}

// HasMFA reports whether the verified claims indicate the user passed an
// MFA challenge — either via amr containing "mfa" or any non-empty acr.
// This is a shape check; for freshness-aware gating, the middleware uses
// the mfa_at claim per SPEC §10.4.
func (c *Claims) HasMFA() bool {
	if c == nil {
		return false
	}
	for _, m := range c.AMR {
		if m == "mfa" {
			return true
		}
	}
	return c.ACR != ""
}

// SessionKey is the key every session-scoped check uses (SPEC §6.7.1): `sid`
// when non-empty, else `jti`, else "" (no key: nothing recorded or refused).
func (c *Claims) SessionKey() string {
	if c == nil {
		return ""
	}
	if c.SessionID != "" {
		return c.SessionID
	}
	return c.JWTID
}
