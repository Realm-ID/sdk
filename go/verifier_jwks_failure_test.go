package realmid

// SPEC §2 — any failure to fetch or parse the JWKS is jwks_fetch_failed and is
// the recorded attempt; one bad key fails the whole set.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func verifyAgainstBody(t *testing.T, mk func(good jwk) string) (error, int32) {
	t.Helper()
	sign, key := mintKey(t, "kid-known")
	var n int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&n, 1)
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
	return err, atomic.LoadInt32(&n)
}

func TestVerify_UnusableJWKSIsFetchFailed(t *testing.T) {
	withBad := func(bad jwk) func(jwk) string {
		return func(good jwk) string {
			b, _ := json.Marshal(jwksDoc{Keys: []jwk{good, bad}})
			return string(b)
		}
	}
	bodies := map[string]func(jwk) string{
		"not json":      func(jwk) string { return "<html>not json</html>" },
		"keys not list": func(jwk) string { return `{"keys":"x"}` },
		"bad modulus":   withBad(jwk{Kty: "RSA", Kid: "kid-bad", N: "@@@", E: "AQAB"}),
		"bad exponent":  withBad(jwk{Kty: "RSA", Kid: "kid-bad", N: "AQAB", E: "@@@"}),
	}
	for name, mk := range bodies {
		t.Run(name, func(t *testing.T) {
			err, _ := verifyAgainstBody(t, mk)
			var re *RealmError
			if !errors.As(err, &re) || re.Code != ErrCodeJWKSFetchFailed {
				t.Fatalf("err = %v, want jwks_fetch_failed", err)
			}
		})
	}
}

func TestVerify_EmptyKeysArrayIsUnknownKid(t *testing.T) {
	err, _ := verifyAgainstBody(t, func(jwk) string { return `{"keys":[]}` })
	var re *RealmError
	if !errors.As(err, &re) || re.Code != ErrCodeUnknownKID {
		t.Fatalf("err = %v, want unknown_kid", err)
	}
}
