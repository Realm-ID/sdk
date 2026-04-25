package realmid

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const (
	testRealmID = "01HXYZREALM"
	testAud     = "example.com"
)

type signFn func(claims map[string]any) string

func mintKey(t *testing.T, kid string) (signFn, jwk) {
	t.Helper()
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("rsa generate: %v", err)
	}
	pub := priv.PublicKey
	publicJwk := jwk{
		Kty: "RSA",
		Kid: kid,
		Alg: "RS256",
		Use: "sig",
		N:   base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
		E:   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes()),
	}
	sign := func(claims map[string]any) string {
		hdr := map[string]any{"alg": "RS256", "typ": "JWT", "kid": kid}
		hb, _ := json.Marshal(hdr)
		cb, _ := json.Marshal(claims)
		signing := base64.RawURLEncoding.EncodeToString(hb) + "." +
			base64.RawURLEncoding.EncodeToString(cb)
		sum := sha256.Sum256([]byte(signing))
		sig, err := rsa.SignPKCS1v15(rand.Reader, priv, crypto.SHA256, sum[:])
		if err != nil {
			t.Fatalf("sign: %v", err)
		}
		return signing + "." + base64.RawURLEncoding.EncodeToString(sig)
	}
	return sign, publicJwk
}

func jwksServer(t *testing.T, perRealm map[string][]jwk) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	for realm, keys := range perRealm {
		realm := realm
		keys := keys
		mux.HandleFunc("/"+realm+"/.well-known/jwks.json", func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(jwksDoc{Keys: keys})
		})
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})
	return httptest.NewServer(mux)
}

func baseClaims(srv string, opts ...func(map[string]any)) map[string]any {
	now := time.Now().Unix()
	c := map[string]any{
		"iss": srv + "/" + testRealmID,
		"sub": "01HUSER",
		"aud": testAud,
		"iat": now,
		"exp": now + 600,
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

func mustVerifier(t *testing.T, srv string) *Verifier {
	t.Helper()
	v, err := NewVerifier(Config{BaseURL: srv, Audience: testAud})
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}
	return v
}

func TestVerify_HappyPath(t *testing.T) {
	sign, pub := mintKey(t, "kid-1")
	srv := jwksServer(t, map[string][]jwk{testRealmID: {pub}})
	defer srv.Close()

	v := mustVerifier(t, srv.URL)
	tok := sign(baseClaims(srv.URL, func(c map[string]any) {
		c["tenant_id"] = "01HTENANT"
		c["role"] = "owner"
		c["jti"] = "01HJTI"
		c["custom_field"] = "x"
	}))
	claims, err := v.Verify(tok)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if claims.TenantID != "01HTENANT" {
		t.Errorf("tenant_id: got %q", claims.TenantID)
	}
	if claims.Role != "owner" {
		t.Errorf("role: got %q", claims.Role)
	}
	if claims.Extra["custom_field"] != "x" {
		t.Errorf("extra custom_field: got %v", claims.Extra["custom_field"])
	}
}

func TestVerify_Errors(t *testing.T) {
	sign, pub := mintKey(t, "kid-1")
	srv := jwksServer(t, map[string][]jwk{testRealmID: {pub}})
	defer srv.Close()
	v := mustVerifier(t, srv.URL)

	type tc struct {
		name  string
		token string
		want  ErrorCode
	}
	cases := []tc{
		{"malformed-not-3-parts", "a.b", ErrCodeMalformed},
		{"wrong-aud", sign(baseClaims(srv.URL, func(c map[string]any) { c["aud"] = "other" })), ErrCodeWrongAudience},
		{"wrong-iss", sign(baseClaims(srv.URL, func(c map[string]any) { c["iss"] = "https://evil.example/" + testRealmID })), ErrCodeWrongIssuer},
		{"expired", sign(baseClaims(srv.URL, func(c map[string]any) { c["exp"] = time.Now().Add(-time.Hour).Unix() })), ErrCodeExpired},
		{"not-yet-valid", sign(baseClaims(srv.URL, func(c map[string]any) { c["nbf"] = time.Now().Add(time.Hour).Unix() })), ErrCodeNotYetValid},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := v.Verify(c.token)
			if err == nil {
				t.Fatalf("expected error")
			}
			var verr *Error
			if !errors.As(err, &verr) {
				t.Fatalf("expected *Error, got %T", err)
			}
			if verr.Code != c.want {
				t.Errorf("code: got %s, want %s", verr.Code, c.want)
			}
		})
	}
}

func TestVerify_UnknownKID_RefetchesAndStillFails(t *testing.T) {
	signKnown, pubKnown := mintKey(t, "kid-known")
	_ = signKnown
	srv := jwksServer(t, map[string][]jwk{testRealmID: {pubKnown}})
	defer srv.Close()
	v := mustVerifier(t, srv.URL)

	// Sign with a different kid not in JWKS.
	signUnknown, _ := mintKey(t, "kid-unknown")
	tok := signUnknown(baseClaims(srv.URL))
	_, err := v.Verify(tok)
	var verr *Error
	if !errors.As(err, &verr) || verr.Code != ErrCodeUnknownKID {
		t.Fatalf("expected unknown_kid, got %v", err)
	}
}

func TestVerify_BadSignature(t *testing.T) {
	sign, pub := mintKey(t, "kid-1")
	srv := jwksServer(t, map[string][]jwk{testRealmID: {pub}})
	defer srv.Close()
	v := mustVerifier(t, srv.URL)
	tok := sign(baseClaims(srv.URL))

	// Mangle signature.
	parts := strings.Split(tok, ".")
	mangled := parts[0] + "." + parts[1] + "." + base64.RawURLEncoding.EncodeToString([]byte("not-a-real-sig"))
	_, err := v.Verify(mangled)
	var verr *Error
	if !errors.As(err, &verr) || verr.Code != ErrCodeBadSignature {
		t.Fatalf("expected bad_signature, got %v", err)
	}
}

func TestVerify_JWKSFetchFailed(t *testing.T) {
	v, _ := NewVerifier(Config{BaseURL: "http://127.0.0.1:1", Audience: testAud})
	sign, _ := mintKey(t, "kid-1")
	tok := sign(map[string]any{
		"iss": "http://127.0.0.1:1/" + testRealmID,
		"sub": "x", "aud": testAud, "exp": time.Now().Unix() + 600,
	})
	_, err := v.Verify(tok)
	var verr *Error
	if !errors.As(err, &verr) || verr.Code != ErrCodeJWKSFetchFailed {
		t.Fatalf("expected jwks_fetch_failed, got %v", err)
	}
}

func TestNewVerifier_Validation(t *testing.T) {
	if _, err := NewVerifier(Config{Audience: "x"}); err == nil {
		t.Fatal("expected error for missing BaseURL")
	}
	if _, err := NewVerifier(Config{BaseURL: "x"}); err == nil {
		t.Fatal("expected error for missing Audience")
	}
}

// Compile-time check that fmt is used (it is — newErr uses fmt.Sprintf).
var _ = fmt.Sprintf
