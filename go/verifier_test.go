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

// fakeServer wires JWKS endpoints + a stub /platforms/mine + a stub
// /auth/login (platform_api_key grant) so a fully-configured *Realm can
// exercise the verifier end-to-end without the live API.
func fakeServer(t *testing.T, perRealm map[string][]jwk, audience string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	for realm, keys := range perRealm {
		realm := realm
		keys := keys
		mux.HandleFunc("/"+realm+"/.well-known/jwks.json", func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(jwksDoc{Keys: keys})
		})
	}
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":        "ok",
			"subject_type":  "platform",
			"refresh_token": "rtok-platform",
			"access_token":  "ptok_test_" + testRealmID,
			"expires_in":    300,
		})
	})
	mux.HandleFunc("/platforms/mine", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []any{
				map[string]any{
					"id":       testRealmID,
					"audience": audience,
					"domain":   audience,
				},
			},
		})
	})
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

func mustRealm(t *testing.T, srv string) *Realm {
	t.Helper()
	r, err := NewRealm(Config{
		RealmID: testRealmID,
		APIKey:  "rk_live_test",
		BaseURL: srv,
	})
	if err != nil {
		t.Fatalf("NewRealm: %v", err)
	}
	return r
}

func TestVerify_HappyPath(t *testing.T) {
	sign, pub := mintKey(t, "kid-1")
	srv := fakeServer(t, map[string][]jwk{testRealmID: {pub}}, testAud)
	defer srv.Close()

	r := mustRealm(t, srv.URL)
	tok := sign(baseClaims(srv.URL, func(c map[string]any) {
		c["tenant_id"] = "01HTENANT"
		c["role"] = "owner"
		c["jti"] = "01HJTI"
		c["custom_field"] = "x"
	}))
	claims, err := r.Verify(context.Background(), tok, nil)
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
	srv := fakeServer(t, map[string][]jwk{testRealmID: {pub}}, testAud)
	defer srv.Close()
	r := mustRealm(t, srv.URL)

	cases := []struct {
		name  string
		token string
		want  ErrorCode
	}{
		{"malformed-not-3-parts", "a.b", ErrCodeMalformed},
		{"wrong-aud", sign(baseClaims(srv.URL, func(c map[string]any) { c["aud"] = "other" })), ErrCodeWrongAudience},
		{"wrong-iss", sign(baseClaims(srv.URL, func(c map[string]any) { c["iss"] = "https://evil.example/" + testRealmID })), ErrCodeWrongIssuer},
		{"expired", sign(baseClaims(srv.URL, func(c map[string]any) { c["exp"] = time.Now().Add(-time.Hour).Unix() })), ErrCodeExpired},
		{"not-yet-valid", sign(baseClaims(srv.URL, func(c map[string]any) { c["nbf"] = time.Now().Add(time.Hour).Unix() })), ErrCodeNotYetValid},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := r.Verify(context.Background(), c.token, nil)
			if err == nil {
				t.Fatalf("expected error")
			}
			var verr *RealmError
			if !errors.As(err, &verr) {
				t.Fatalf("expected *RealmError, got %T", err)
			}
			if verr.Code != c.want {
				t.Errorf("code: got %s, want %s", verr.Code, c.want)
			}
		})
	}
}

func TestVerify_UnknownKID_RefetchesAndStillFails(t *testing.T) {
	_, pubKnown := mintKey(t, "kid-known")
	srv := fakeServer(t, map[string][]jwk{testRealmID: {pubKnown}}, testAud)
	defer srv.Close()
	r := mustRealm(t, srv.URL)

	signUnknown, _ := mintKey(t, "kid-unknown")
	tok := signUnknown(baseClaims(srv.URL))
	_, err := r.Verify(context.Background(), tok, nil)
	var verr *RealmError
	if !errors.As(err, &verr) || verr.Code != ErrCodeUnknownKID {
		t.Fatalf("expected unknown_kid, got %v", err)
	}
}

func TestVerify_BadSignature(t *testing.T) {
	sign, pub := mintKey(t, "kid-1")
	srv := fakeServer(t, map[string][]jwk{testRealmID: {pub}}, testAud)
	defer srv.Close()
	r := mustRealm(t, srv.URL)
	tok := sign(baseClaims(srv.URL))

	parts := strings.Split(tok, ".")
	mangled := parts[0] + "." + parts[1] + "." + base64.RawURLEncoding.EncodeToString([]byte("not-a-real-sig"))
	_, err := r.Verify(context.Background(), mangled, nil)
	var verr *RealmError
	if !errors.As(err, &verr) || verr.Code != ErrCodeBadSignature {
		t.Fatalf("expected bad_signature, got %v", err)
	}
}

func TestVerify_JWKSFetchFailed(t *testing.T) {
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: "http://127.0.0.1:1"})
	sign, _ := mintKey(t, "kid-1")
	// Stub audience cache so the verifier does not block on info().
	r.info.cached = &RealmInfo{ID: testRealmID, Audience: testAud}
	tok := sign(map[string]any{
		"iss": "http://127.0.0.1:1/" + testRealmID,
		"sub": "x", "aud": testAud, "exp": time.Now().Unix() + 600,
	})
	_, err := r.Verify(context.Background(), tok, nil)
	var verr *RealmError
	if !errors.As(err, &verr) || verr.Code != ErrCodeJWKSFetchFailed {
		t.Fatalf("expected jwks_fetch_failed, got %v", err)
	}
}

func TestNewRealm_Validation(t *testing.T) {
	if _, err := NewRealm(Config{APIKey: "x"}); err == nil {
		t.Fatal("expected error for missing RealmID")
	}
	if _, err := NewRealm(Config{RealmID: "x"}); err == nil {
		t.Fatal("expected error for missing APIKey")
	}
}

// Compile-time check that fmt is used.
var _ = fmt.Sprintf
