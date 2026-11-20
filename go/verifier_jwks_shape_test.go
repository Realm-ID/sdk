package realmid

// SPEC §2 — JWKS response shape: any 2xx is parsed, a key without a kid is
// ignored, a key with a kid but unusable RSA material fails the whole set.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func verifyShape(t *testing.T, status int, mk func(good jwk) string) error {
	t.Helper()
	sign, key := mintKey(t, "kid-known")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(mk(key)))
	}))
	defer srv.Close()
	r, err := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk_live_test", BaseURL: srv.URL})
	if err != nil {
		t.Fatalf("NewRealm: %v", err)
	}
	now := time.Now()
	tok := sign(map[string]any{"iss": srv.URL + "/" + testRealmID, "sub": "u1", "aud": testAud, "iat": now.Unix(), "exp": now.Unix() + 3600})
	_, err = r.Verify(context.Background(), tok, &VerifyOptions{Audience: testAud})
	return err
}

func shapeSet(extra ...jwk) func(jwk) string {
	return func(good jwk) string {
		b, _ := json.Marshal(jwksDoc{Keys: append([]jwk{good}, extra...)})
		return string(b)
	}
}

// wantShape asserts success when code is empty, else that the error carries code.
func wantShape(t *testing.T, err error, code ErrorCode) {
	t.Helper()
	if code == "" {
		if err != nil {
			t.Fatalf("err = %v, want success", err)
		}
		return
	}
	var re *RealmError
	if !errors.As(err, &re) || re.Code != code {
		t.Fatalf("err = %v, want %s", err, code)
	}
}

func TestJWKSShape_AnyTwoXXIsParsed(t *testing.T) {
	for _, status := range []int{200, 201, 203} {
		wantShape(t, verifyShape(t, status, shapeSet()), "")
	}
}

func TestJWKSShape_NonTwoXXIsFetchFailed(t *testing.T) {
	for _, status := range []int{404, 500} {
		wantShape(t, verifyShape(t, status, shapeSet()), ErrCodeJWKSFetchFailed)
	}
}

func TestJWKSShape_KeyWithoutKidIsIgnored(t *testing.T) {
	cases := map[string]jwk{
		"unusable material": {Kty: "RSA", N: "@@@", E: "AQAB"},
		"empty material":    {Kty: "RSA"},
		"usable material":   {Kty: "RSA", N: "AQAB", E: "AQAB"},
	}
	for name, k := range cases {
		t.Run(name, func(t *testing.T) {
			wantShape(t, verifyShape(t, 200, shapeSet(k)), "")
		})
	}
}

func TestJWKSShape_KidWithUnusableMaterialFailsTheSet(t *testing.T) {
	cases := map[string]jwk{
		"n missing":      {Kty: "RSA", Kid: "kid-bad", E: "AQAB"},
		"e missing":      {Kty: "RSA", Kid: "kid-bad", N: "AQAB"},
		"n empty":        {Kty: "RSA", Kid: "kid-bad", N: "", E: "AQAB"},
		"e empty":        {Kty: "RSA", Kid: "kid-bad", N: "AQAB", E: ""},
		"n undecodable":  {Kty: "RSA", Kid: "kid-bad", N: "@@@", E: "AQAB"},
		"e undecodable":  {Kty: "RSA", Kid: "kid-bad", N: "AQAB", E: "@@@"},
		"n decodes to 0": {Kty: "RSA", Kid: "kid-bad", N: "AA", E: "AQAB"},
		"e decodes to 0": {Kty: "RSA", Kid: "kid-bad", N: "AQAB", E: "AA"},
		"n padded":       {Kty: "RSA", Kid: "kid-bad", N: "AQAB=", E: "AQAB"},
		"e padded":       {Kty: "RSA", Kid: "kid-bad", N: "AQAB", E: "AQAB="},
	}
	for name, k := range cases {
		t.Run(name, func(t *testing.T) {
			wantShape(t, verifyShape(t, 200, shapeSet(k)), ErrCodeJWKSFetchFailed)
		})
	}
}

// A kid that is present but not a JSON string is skipped like an absent kid;
// the rest of the set is used.
func TestJWKSShape_NonStringKidIsSkipped(t *testing.T) {
	for _, kid := range []string{`123`, `true`, `{"a":1}`, `["x"]`, `null`} {
		t.Run(kid, func(t *testing.T) {
			wantShape(t, verifyShape(t, 200, func(good jwk) string {
				g, _ := json.Marshal(good)
				return `{"keys":[{"kty":"RSA","kid":` + kid + `,"n":"AQAB","e":"AQAB"},` + string(g) + `]}`
			}), "")
		})
	}
}

// base64url padding on n or e is "not decodable": the whole set fails, even
// when the unpadded form is a valid key.
func TestJWKSShape_PaddedMaterialFailsTheSet(t *testing.T) {
	wantShape(t, verifyShape(t, 200, func(good jwk) string {
		bad := good
		bad.Kid, bad.N = "kid-bad", good.N+"=="
		b, _ := json.Marshal(jwksDoc{Keys: []jwk{good, bad}})
		return string(b)
	}), ErrCodeJWKSFetchFailed)
	wantShape(t, verifyShape(t, 200, shapeSet(jwk{Kty: "RSA", Kid: "kid-bad", N: "AQAB", E: "AQABAQ=="})), ErrCodeJWKSFetchFailed)
}

func TestJWKSShape_NonObjectTopLevelIsFetchFailed(t *testing.T) {
	for _, body := range []string{``, `[]`, `"x"`, `5`} {
		wantShape(t, verifyShape(t, 200, func(jwk) string { return body }), ErrCodeJWKSFetchFailed)
	}
}

func TestJWKSShape_AbsentOrNullKeysIsUnknownKid(t *testing.T) {
	for _, body := range []string{`{}`, `{"keys":null}`, `{"keys":[]}`} {
		wantShape(t, verifyShape(t, 200, func(jwk) string { return body }), ErrCodeUnknownKID)
	}
}
