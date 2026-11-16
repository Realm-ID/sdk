package realmid

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"sort"
	"strings"
	"testing"
)

// SPEC4_2_claim_fold (sdk/SPEC.md §4.2, audit e-02): shared cases in
// ../testdata/claim-fold-vectors/vectors.json. The runner asserts how many
// cases it ran and drives a refuse per reason through a SIGNED token.

type foldVectors struct {
	Reserved         []string `json:"reserved"`
	KeyCaseCount     int      `json:"key_case_count"`
	PayloadCaseCount int      `json:"payload_case_count"`
	Keys             []struct {
		ID     string `json:"id"`
		Key    string `json:"key"`
		Expect string `json:"expect"`
	} `json:"keys"`
	Payloads []struct {
		ID          string `json:"id"`
		PayloadJSON string `json:"payload_json"`
		Expect      string `json:"expect"`
	} `json:"payloads"`
}

func loadFoldVectors(t *testing.T) foldVectors {
	t.Helper()
	b, err := os.ReadFile("../testdata/claim-fold-vectors/vectors.json")
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var v foldVectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	return v
}

func TestClaimFoldVectors(t *testing.T) {
	v := loadFoldVectors(t)
	// Drift check: our reserved set equals the vector file's, exactly.
	got := append([]string(nil), foldReservedNames...)
	want := append([]string(nil), v.Reserved...)
	sort.Strings(got)
	sort.Strings(want)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("reserved set drift:\n sdk  %v\n file %v", got, want)
	}
	failed, kRan, pRan := 0, 0, 0
	for _, c := range v.Keys {
		kRan++
		res := "accept"
		if err := checkCustomClaimKey(c.Key); err != nil {
			res = "refuse_reserved"
			if !isPrintableASCIIKey(c.Key) {
				res = "refuse_charset"
			}
		}
		if res != c.Expect {
			failed++
			t.Errorf("key %s %q: got %s want %s", c.ID, c.Key, res, c.Expect)
		}
	}
	for _, c := range v.Payloads {
		pRan++
		res := "accept"
		if err := checkClaimFold([]byte(c.PayloadJSON)); err != nil {
			res = "refuse"
		}
		if res != c.Expect {
			failed++
			t.Errorf("payload %s: got %s want %s", c.ID, res, c.Expect)
		}
	}
	fmt.Printf("claim-fold-vectors go: ran %d key + %d payload cases, %d failed\n", kRan, pRan, failed)
	if kRan == 0 || pRan == 0 || kRan != v.KeyCaseCount || pRan != v.PayloadCaseCount {
		t.Fatalf("ran %d/%d key and %d/%d payload cases", kRan, v.KeyCaseCount, pRan, v.PayloadCaseCount)
	}
}

// foldSigner returns the JWKS entry and a signer of RAW payload text (a map
// cannot carry a duplicate key).
func foldSigner(t *testing.T, kid string) (jwk, func(payload string) string) {
	t.Helper()
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pub := jwk{Kty: "RSA", Kid: kid, Alg: "RS256", Use: "sig",
		N: base64.RawURLEncoding.EncodeToString(priv.PublicKey.N.Bytes()),
		E: base64.RawURLEncoding.EncodeToString(big.NewInt(int64(priv.PublicKey.E)).Bytes())}
	return pub, func(payload string) string {
		hb, _ := json.Marshal(map[string]any{"alg": "RS256", "typ": "JWT", "kid": kid})
		signing := base64.RawURLEncoding.EncodeToString(hb) + "." + base64.RawURLEncoding.EncodeToString([]byte(payload))
		sum := sha256.Sum256([]byte(signing))
		sig, err := rsa.SignPKCS1v15(rand.Reader, priv, crypto.SHA256, sum[:])
		if err != nil {
			t.Fatal(err)
		}
		return signing + "." + base64.RawURLEncoding.EncodeToString(sig)
	}
}

func TestVerify_RefusesFoldCollisionsEndToEnd(t *testing.T) {
	cases := map[string]string{
		"case variant of reserved":   `"Sub":"attacker"`,
		"acr case variant":           `"ACR":"mfa"`,
		"long-s unicode variant":     `"ſub":"attacker"`,
		"kelvin sign variant":        `"toKen_class":"x"`,
		"non-ascii custom key":       `"région":"x"`,
		"exact duplicate custom key": `"a":"1","a":"2"`,
		"fold pair of custom keys":   `"Out":"1","out":"2"`,
	}
	pub, sign := foldSigner(t, "kid-f")
	srv := fakeServer(t, map[string][]jwk{testRealmID: {pub}}, testAud)
	defer srv.Close()
	r := mustRealm(t, srv.URL)
	mk := func(extra string) string {
		return fmt.Sprintf(`{"iss":"%s/%s","sub":"01HUSER","aud":"%s","iat":1,"exp":4102444800%s}`,
			srv.URL, testRealmID, testAud, extra)
	}
	// Positive control: the same shape without the offending key verifies.
	if _, err := r.Verify(context.Background(), sign(mk(`,"outlets":["o1"]`)), nil); err != nil {
		t.Fatalf("positive control: %v", err)
	}
	for name, extra := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := r.Verify(context.Background(), sign(mk(","+extra)), nil)
			var re *RealmError
			if !errors.As(err, &re) || re.Code != ErrCodeMalformed {
				t.Fatalf("want malformed, got %v", err)
			}
		})
	}
}

func TestParseClaimsUnverified_RefusesFoldCollisions(t *testing.T) {
	for _, p := range []string{`{"sub":"a","Sub":"b"}`, `{"sub":"a","ſub":"b"}`, `{"sub":"a","ACR":"x"}`, `{"sub":"a","a":1,"a":2}`} {
		c, err := ParseClaimsUnverified(makeUnsignedJWT(p))
		var re *RealmError
		if c != nil || !errors.As(err, &re) || re.Code != ErrCodeMalformed {
			t.Errorf("%s: want nil+malformed, got %v %v", p, c, err)
		}
	}
	if _, err := ParseClaimsUnverified(makeUnsignedJWT(`{"sub":"a","acr":"x","outlets":[1]}`)); err != nil {
		t.Fatalf("positive control: %v", err)
	}
}
