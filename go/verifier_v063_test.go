package realmid

// SPEC5_1 / SPEC5_1_1 — blank `sub`, `typ` allowlist, `events` refusal (v0.63.0).

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// hdrSigner signs claims under a caller-chosen JOSE header, so a test can
// produce the typ shapes mintKey's fixed "JWT" header never emits.
type hdrSigner func(hdr, claims map[string]any) string

func mintKeyHdr(t *testing.T, kid string) (hdrSigner, jwk) {
	t.Helper()
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("rsa generate: %v", err)
	}
	pub := priv.PublicKey
	pj := jwk{Kty: "RSA", Kid: kid, Alg: "RS256", Use: "sig",
		N: base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
		E: base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes())}
	return func(hdr, claims map[string]any) string {
		hb, _ := json.Marshal(hdr)
		cb, _ := json.Marshal(claims)
		signing := base64.RawURLEncoding.EncodeToString(hb) + "." + base64.RawURLEncoding.EncodeToString(cb)
		sum := sha256.Sum256([]byte(signing))
		sig, err := rsa.SignPKCS1v15(rand.Reader, priv, crypto.SHA256, sum[:])
		if err != nil {
			t.Fatalf("sign: %v", err)
		}
		return signing + "." + base64.RawURLEncoding.EncodeToString(sig)
	}, pj
}

type v063Env struct {
	srv       *httptest.Server
	realm     *Realm
	sign      hdrSigner
	jwksFetch *atomic.Int32
}

func newV063Env(t *testing.T, cfg func(*Config)) *v063Env {
	t.Helper()
	sign, key := mintKeyHdr(t, "k1")
	fetches := &atomic.Int32{}
	mux := http.NewServeMux()
	mux.HandleFunc("/"+testRealmID+"/.well-known/jwks.json", func(w http.ResponseWriter, _ *http.Request) {
		fetches.Add(1)
		_ = json.NewEncoder(w).Encode(jwksDoc{Keys: []jwk{key}})
	})
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "subject_type": "platform", "refresh_token": "rtok-platform", "access_token": "ptok_test_" + testRealmID, "expires_in": 300})
	})
	mux.HandleFunc("/platforms/mine", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{map[string]any{"id": testRealmID, "audience": testAud, "domain": testAud}}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := Config{RealmID: testRealmID, APIKey: "rk_live_test", BaseURL: srv.URL}
	if cfg != nil {
		cfg(&c)
	}
	r, err := NewRealm(c)
	if err != nil {
		t.Fatalf("NewRealm: %v", err)
	}
	return &v063Env{srv: srv, realm: r, sign: sign, jwksFetch: fetches}
}

func (e *v063Env) tok(hdr map[string]any, mod func(map[string]any)) string {
	if hdr == nil {
		hdr = map[string]any{"alg": "RS256", "typ": "JWT", "kid": "k1"}
	}
	c := baseClaims(e.srv.URL)
	if mod != nil {
		mod(c)
	}
	return e.sign(hdr, c)
}

func hdrTyp(typ any) map[string]any {
	h := map[string]any{"alg": "RS256", "kid": "k1"}
	if typ != nil {
		h["typ"] = typ
	}
	return h
}

func wantMalformed(t *testing.T, err error, msgPart string) {
	t.Helper()
	var re *RealmError
	if !errors.As(err, &re) || re.Code != ErrCodeMalformed {
		t.Fatalf("want malformed, got %v", err)
	}
	if msgPart != "" && !strings.Contains(re.Message, msgPart) {
		t.Fatalf("message %q lacks %q", re.Message, msgPart)
	}
	if re.HTTPStatus != http.StatusUnauthorized {
		t.Fatalf("HTTPStatus = %d, want 401", re.HTTPStatus)
	}
}

func TestSPEC5_1_BlankSubRefused(t *testing.T) {
	e := newV063Env(t, nil)
	cases := map[string]func(map[string]any){
		"absent":   func(c map[string]any) { delete(c, "sub") },
		"null":     func(c map[string]any) { c["sub"] = nil },
		"empty":    func(c map[string]any) { c["sub"] = "" },
		"space":    func(c map[string]any) { c["sub"] = "   " },
		"tabnl":    func(c map[string]any) { c["sub"] = "\t\n" },
		"vt-ff-cr": func(c map[string]any) { c["sub"] = "\v\f\r" },
	}
	for name, mod := range cases {
		_, err := e.realm.Verify(context.Background(), e.tok(nil, mod), nil)
		if err == nil {
			t.Fatalf("%s: verified, want malformed", name)
		}
		var re *RealmError
		if !errors.As(err, &re) || re.Code != ErrCodeMalformed {
			t.Fatalf("%s: got %v", name, err)
		}
		if name != "number" && re.HTTPStatus != http.StatusUnauthorized {
			t.Fatalf("%s: HTTPStatus %d", name, re.HTTPStatus)
		}
	}
	// number: refused (by the claims decode, as today)
	if _, err := e.realm.Verify(context.Background(), e.tok(nil, func(c map[string]any) { c["sub"] = 42 }), nil); err == nil {
		t.Fatal("numeric sub verified")
	}
	// NBSP and padded values verify verbatim
	for _, s := range []string{" ", " u1 "} {
		cl, err := e.realm.Verify(context.Background(), e.tok(nil, func(c map[string]any) { c["sub"] = s }), nil)
		if err != nil || cl.Subject != s {
			t.Fatalf("sub %q: %v %v", s, cl, err)
		}
	}
	if _, err := e.realm.Verify(context.Background(), e.tok(nil, nil), nil); err != nil {
		t.Fatalf("positive control: %v", err)
	}
	// expired + blank sub reports expired
	_, err := e.realm.Verify(context.Background(), e.tok(nil, func(c map[string]any) { c["sub"] = ""; c["exp"] = 1 }), nil)
	var re *RealmError
	if !errors.As(err, &re) || re.Code != ErrCodeExpired {
		t.Fatalf("expired+blank: %v", err)
	}
}

func TestSPEC5_1_BlankSubNeverReachesAuthorityCache(t *testing.T) {
	spy := &spyAuthority{}
	e := newV063Env(t, func(c *Config) { c.Authority = spy })
	_, err := e.realm.Verify(context.Background(), e.tok(nil, func(c map[string]any) { c["sub"] = "" }), nil)
	wantMalformed(t, err, "")
	if spy.calls.Load() != 0 {
		t.Fatalf("authority cache consulted %d times", spy.calls.Load())
	}
}

type spyAuthority struct{ calls atomic.Int32 }

func (s *spyAuthority) StaleSince(_ context.Context, _ string) (t0 time.Time, found bool, err error) {
	s.calls.Add(1)
	return
}
func (s *spyAuthority) MarkStale(_ context.Context, _ string, _ time.Time, _ time.Time) error {
	s.calls.Add(1)
	return nil
}

func TestSPEC5_1_1_TypAllowlist(t *testing.T) {
	e := newV063Env(t, nil)
	bad := map[string]any{"absent": nil, "logout": "logout+jwt", "lead": " JWT", "trail": "at+jwt ", "num": 42}
	for name, typ := range bad {
		_, err := e.realm.Verify(context.Background(), e.tok(hdrTyp(typ), nil), nil)
		if err == nil {
			t.Fatalf("%s: verified", name)
		}
		var re *RealmError
		if !errors.As(err, &re) || re.Code != ErrCodeMalformed {
			t.Fatalf("%s: %v", name, err)
		}
	}
	_, err := e.realm.Verify(context.Background(), e.tok(hdrTyp(nil), nil), nil)
	wantMalformed(t, err, "unexpected token type: <absent>")
	for _, typ := range []string{"JWT", "jwt", "Jwt", "at+jwt", "AT+JWT", "application/at+jwt", "Application/AT+JWT"} {
		if _, err := e.realm.Verify(context.Background(), e.tok(hdrTyp(typ), nil), nil); err != nil {
			t.Fatalf("typ %q refused: %v", typ, err)
		}
	}
}

func TestSPEC5_1_1_TypRefusedBeforeKidLookup(t *testing.T) {
	e := newV063Env(t, nil)
	h := hdrTyp("logout+jwt")
	h["kid"] = "unknown"
	_, err := e.realm.Verify(context.Background(), e.tok(h, nil), nil)
	wantMalformed(t, err, "")
	if n := e.jwksFetch.Load(); n != 0 {
		t.Fatalf("JWKS fetched %d times", n)
	}
}

func TestSPEC5_1_1_EventsRefused(t *testing.T) {
	spy := &spyRevocation{}
	e := newV063Env(t, func(c *Config) { c.Revocation = spy })
	for name, ev := range map[string]any{
		"backchannel": map[string]any{"http://schemas.openid.net/event/backchannel-logout": map[string]any{}},
		"empty":       map[string]any{},
		"null":        nil,
		"custom":      []any{"signup"},
	} {
		_, err := e.realm.Verify(context.Background(), e.tok(nil, func(c map[string]any) { c["events"] = ev }), nil)
		wantMalformed(t, err, "token carries an events claim")
		_ = name
	}
	if spy.calls.Load() != 0 {
		t.Fatalf("revocation consulted %d times", spy.calls.Load())
	}
	// full ADR-110 logout token shape
	_, err := e.realm.Verify(context.Background(), e.tok(hdrTyp("logout+jwt"), func(c map[string]any) {
		delete(c, "sub")
		c["sid"] = "S1"
		c["events"] = map[string]any{"http://schemas.openid.net/event/backchannel-logout": map[string]any{}}
	}), nil)
	wantMalformed(t, err, "")
}

type spyRevocation struct{ calls atomic.Int32 }

func (s *spyRevocation) Revoke(_ context.Context, _ string, _ time.Time) error {
	s.calls.Add(1)
	return nil
}
func (s *spyRevocation) IsRevoked(_ context.Context, _ string) (bool, error) {
	s.calls.Add(1)
	return false, nil
}
