package realmid

// Claims is the verified token payload. Standard JWT fields plus the
// RealmID-specific extras (azp, tenant_id, role). Unknown fields land in
// Extra.
type Claims struct {
	Issuer          string         `json:"iss,omitempty"`
	Subject         string         `json:"sub,omitempty"`
	Audience        string         `json:"aud,omitempty"`
	IssuedAt        int64          `json:"iat,omitempty"`
	NotBefore       int64          `json:"nbf,omitempty"`
	Expiry          int64          `json:"exp,omitempty"`
	JWTID           string         `json:"jti,omitempty"`
	AuthorizedParty string         `json:"azp,omitempty"`
	TenantID        string         `json:"tenant_id,omitempty"`
	Role            string         `json:"role,omitempty"`
	AMR             []string       `json:"amr,omitempty"`
	ACR             string         `json:"acr,omitempty"`
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
	"jti": {}, "azp": {}, "tenant_id": {}, "role": {}, "amr": {}, "acr": {},
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
