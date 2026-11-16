package realmid

import (
	"encoding/base64"
	"testing"
)

// custom_claims_peek_test.go — audit e-02 in peekSession.
// Spec: SPEC.md SPEC4_2_claim_fold rule 2 (§4.2): a payload with a fold
// collision, a reserved-name fold variant or a non-printable-ASCII key is
// malformed, also on the unverified session peek.
func TestSPEC4_2_PeekSessionRefusesFoldViolations(t *testing.T) {
	enc := func(p string) string {
		return "e30." + base64.RawURLEncoding.EncodeToString([]byte(p)) + ".sig"
	}
	bad := map[string]string{
		"fold collision":     `{"sub":"u","Foo":1,"foo":2}`,
		"exact duplicate":    `{"sub":"u","sid":"a","sid":"b"}`,
		"reserved fold":      `{"sub":"u","SID":"x"}`,
		"reserved fold role": `{"sub":"u","Role":"admin"}`,
		"non printable key":  "{\"sub\":\"u\",\"a\\u0001b\":1}",
		"non ascii key":      "{\"sub\":\"u\",\"café\":1}",
		"empty key":          `{"sub":"u","":1}`,
	}
	for name, p := range bad {
		if _, err := peekSession(enc(p)); err == nil {
			t.Errorf("%s: peekSession accepted %s", name, p)
		}
	}
	if pk, err := peekSession(enc(`{"sub":"u","sid":"S1","iat":5,"foo":1,"Foo2":2}`)); err != nil || pk.Key != "S1" {
		t.Errorf("clean payload refused: %v %+v", err, pk)
	}
}
