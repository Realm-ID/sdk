package realmid

import (
	"encoding/base64"
	"strings"
	"testing"
)

func makeUnsignedJWT(payload string) string {
	b64 := func(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
	return b64(`{"alg":"RS256","typ":"JWT","kid":"k1"}`) + "." + b64(payload) + "." + b64("not-a-signature")
}

func TestParseClaimsUnverified_ReadsTheStandardAndRealmIDClaims(t *testing.T) {
	tok := makeUnsignedJWT(`{"iss":"https://auth.example/realm-1","sub":"user-9",` +
		`"aud":"realmid","tenant_id":"t-3","role":"member","mfa_at":1756500000,` +
		`"amr":["mfa"],"acr":"aal2","exp":1756600000}`)
	c, err := ParseClaimsUnverified(tok)
	if err != nil {
		t.Fatalf("ParseClaimsUnverified: %v", err)
	}
	if c.Subject != "user-9" {
		t.Errorf("Subject = %q, want user-9", c.Subject)
	}
	if c.MFAAt != 1756500000 {
		t.Errorf("MFAAt = %d, want 1756500000", c.MFAAt)
	}
	if c.TenantID != "t-3" {
		t.Errorf("TenantID = %q, want t-3", c.TenantID)
	}
	if c.Issuer != "https://auth.example/realm-1" {
		t.Errorf("Issuer = %q", c.Issuer)
	}
	if !c.HasMFA() {
		t.Errorf("HasMFA() = false on a token carrying amr=[mfa]")
	}
}

func TestParseClaimsUnverified_CollectsUnknownClaimsIntoExtra(t *testing.T) {
	tok := makeUnsignedJWT(`{"sub":"u1","token_class":"session","scope":"a b"}`)
	c, err := ParseClaimsUnverified(tok)
	if err != nil {
		t.Fatalf("ParseClaimsUnverified: %v", err)
	}
	if got, _ := c.Extra["token_class"].(string); got != "session" {
		t.Errorf("Extra[token_class] = %v, want session", c.Extra["token_class"])
	}
	if _, reserved := c.Extra["sub"]; reserved {
		t.Errorf("a reserved claim must not be duplicated into Extra")
	}
}

func TestParseClaimsUnverified_FailsToZeroValue(t *testing.T) {
	cases := map[string]string{
		"empty":            "",
		"not a jwt":        "hello",
		"two parts":        "a.b",
		"four parts":       "a.b.c.d",
		"bad base64":       "aaa.!!!!.ccc",
		"payload not json": makeUnsignedJWT(`not json at all`),
		"payload is array": makeUnsignedJWT(`["nope"]`),
	}
	for name, tok := range cases {
		c, err := ParseClaimsUnverified(tok)
		if err == nil {
			t.Errorf("%s: expected an error, got claims %+v", name, c)
		}
		if c != nil {
			t.Errorf("%s: expected nil claims on failure, got %+v", name, c)
		}
	}
}

func TestParseClaimsUnverified_DoesNotVerifyAnything(t *testing.T) {
	// The provenance contract: the signature is NOT checked. A token signed
	// with garbage, expired ten years ago, still parses — that is the whole
	// point, and why the doc comment carries the warning.
	tok := makeUnsignedJWT(`{"sub":"u1","exp":1}`)
	c, err := ParseClaimsUnverified(tok)
	if err != nil {
		t.Fatalf("an expired, unsigned token must still PARSE: %v", err)
	}
	if c.Subject != "u1" {
		t.Errorf("Subject = %q, want u1", c.Subject)
	}
}

func TestParseClaimsUnverified_DocCommentCarriesTheWarning(t *testing.T) {
	// The doc comment IS the safety control for this function — a partner who
	// reads it as a verifier has a broken auth model. Asserting on the source
	// keeps the warning from being edited away.
	src := readSDKSource(t, "claims_unverified.go")
	lower := strings.ToLower(src)
	for _, want := range []string{"unverified", "do not trust", "authorization"} {
		if !strings.Contains(lower, want) {
			t.Errorf("claims_unverified.go doc comment lost the phrase %q", want)
		}
	}
}
