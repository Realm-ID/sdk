package realmid

// Shared fixtures for the split-signing / escort red tests (S1). A fake issuer here is an httptest
// server; no test in this family needs a live issuer (R71).

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type splitKey struct {
	kid  string
	priv *rsa.PrivateKey
	dRI  *big.Int
	dP   *big.Int
}

func b64big(i *big.Int) string { return base64.RawURLEncoding.EncodeToString(i.Bytes()) }

// newSplitKey makes an RSA-2048 key and splits d = d_ri + d_partner (mod lambda).
func newSplitKey(t *testing.T, kid string) *splitKey {
	t.Helper()
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	p1 := new(big.Int).Sub(priv.Primes[0], big.NewInt(1))
	q1 := new(big.Int).Sub(priv.Primes[1], big.NewInt(1))
	lam := new(big.Int).Div(new(big.Int).Mul(p1, q1), new(big.Int).GCD(nil, nil, p1, q1))
	d := new(big.Int).Mod(priv.D, lam)
	dRI, _ := rand.Int(rand.Reader, lam)
	dP := new(big.Int).Mod(new(big.Int).Sub(d, dRI), lam)
	return &splitKey{kid: kid, priv: priv, dRI: dRI, dP: dP}
}

func (k *splitKey) entry() ShareEntry {
	return ShareEntry{N: b64big(k.priv.N), E: b64big(big.NewInt(int64(k.priv.E))), DPartner: b64big(k.dP)}
}

// emsa returns m = EMSA-PKCS1-v1_5 encoding of the digest, recovered as s^e mod n.
func (k *splitKey) emsa(t *testing.T, digest []byte) *big.Int {
	t.Helper()
	s, err := rsa.SignPKCS1v15(nil, k.priv, crypto.SHA256, digest)
	if err != nil {
		t.Fatal(err)
	}
	return new(big.Int).Exp(new(big.Int).SetBytes(s), big.NewInt(int64(k.priv.E)), k.priv.N)
}

func (k *splitKey) riPartial(t *testing.T, digest []byte) []byte {
	t.Helper()
	return new(big.Int).Exp(k.emsa(t, digest), k.dRI, k.priv.N).FillBytes(make([]byte, 256))
}

func (k *splitKey) signingInput(claims map[string]any) (hdr, pl string) {
	hb, _ := json.Marshal(map[string]any{"alg": "RS256", "typ": "JWT", "kid": k.kid})
	cb, _ := json.Marshal(claims)
	return base64.RawURLEncoding.EncodeToString(hb), base64.RawURLEncoding.EncodeToString(cb)
}

// fullJWT signs whole (what a verifier sees after co-signing).
func (k *splitKey) fullJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	h, p := k.signingInput(claims)
	sum := sha256.Sum256([]byte(h + "." + p))
	sig, err := rsa.SignPKCS1v15(rand.Reader, k.priv, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	return h + "." + p + "." + base64.RawURLEncoding.EncodeToString(sig)
}

// partialAnswer builds the /auth/token/partial body for claims.
func (k *splitKey) partialAnswer(t *testing.T, claims map[string]any, refresh string) map[string]any {
	t.Helper()
	h, p := k.signingInput(claims)
	sum := sha256.Sum256([]byte(h + "." + p))
	out := map[string]any{
		"status": "ok", "token_type": "partial", "subject_type": "user", "expires_in": 600,
		"signing": map[string]any{"kid": k.kid, "header": h, "payload": p,
			"partial_ri": base64.RawURLEncoding.EncodeToString(k.riPartial(t, sum[:]))},
	}
	if refresh != "" {
		out["refresh_token"] = refresh
	}
	return out
}

func (k *splitKey) bundle(realm string) *ShareBundle {
	return &ShareBundle{Realm: realm, Shares: map[string]ShareEntry{k.kid: k.entry()}}
}

// memShares is an in-memory writable source for tests.
type memShares struct {
	mu sync.Mutex
	b  *ShareBundle
	v  int
}

func (m *memShares) Load(context.Context) (*ShareBundle, string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.b, string(rune('0' + m.v)), nil
}

func (m *memShares) Store(_ context.Context, b *ShareBundle) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.b = b
	m.v++
	return string(rune('0' + m.v)), nil
}

// seenReq is one recorded issuer request.
type seenReq struct {
	Method, Path, Auth, UserToken string
	Body                          map[string]any
}

// fakeIssuer records every request. Platform mint is served ONLY at /auth/token (R49/R71); a
// platform_api_key sent to /auth/login is recorded and answered 400 login_grant_removed.
type fakeIssuer struct {
	t        *testing.T
	srv      *httptest.Server
	mu       sync.Mutex
	seen     []seenReq
	handlers map[string]func(w http.ResponseWriter, r *http.Request, body map[string]any)
}

func newFakeIssuer(t *testing.T) *fakeIssuer {
	t.Helper()
	f := &fakeIssuer{t: t, handlers: map[string]func(http.ResponseWriter, *http.Request, map[string]any){}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func jsonReply(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (f *fakeIssuer) serve(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	f.mu.Lock()
	f.seen = append(f.seen, seenReq{r.Method, r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("X-User-Token"), body})
	f.mu.Unlock()
	if r.URL.Path == "/auth/token" && body["grant_type"] == "platform_api_key" {
		jsonReply(w, 200, map[string]any{"status": "ok", "subject_type": "platform", "access_token": "ptok", "expires_in": 300})
		return
	}
	if r.URL.Path == "/auth/login" && body["grant_type"] == "platform_api_key" {
		jsonReply(w, 400, map[string]any{"error": map[string]any{"code": "login_grant_removed", "message": "use /auth/token"}})
		return
	}
	if r.URL.Path == "/platforms/mine" {
		jsonReply(w, 200, map[string]any{"items": []any{map[string]any{"id": testRealmID, "audience": testAud}}})
		return
	}
	if h, ok := f.handlers[r.URL.Path]; ok {
		h(w, r, body)
		return
	}
	jsonReply(w, 404, map[string]any{"error": map[string]any{"code": "not_found", "message": r.URL.Path}})
}

func (f *fakeIssuer) on(path string, h func(w http.ResponseWriter, r *http.Request, body map[string]any)) {
	f.handlers[path] = h
}

func (f *fakeIssuer) reqs(path string) []seenReq {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []seenReq
	for _, s := range f.seen {
		if s.Path == path {
			out = append(out, s)
		}
	}
	return out
}

func (f *fakeIssuer) paths() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, s := range f.seen {
		out = append(out, s.Method+" "+s.Path)
	}
	return out
}

func (f *fakeIssuer) realm(t *testing.T, mut func(*Config)) *Realm {
	t.Helper()
	cfg := Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: f.srv.URL, Origin: "https://app.example.com"}
	if mut != nil {
		mut(&cfg)
	}
	r, err := NewRealm(cfg)
	if err != nil {
		t.Fatalf("NewRealm: %v", err)
	}
	return r
}

func userClaims(iss string) map[string]any {
	now := time.Now().Unix()
	return map[string]any{"iss": iss, "sub": "01HUSER", "aud": testAud, "iat": now, "exp": now + 600}
}

func issuerOf(f *fakeIssuer) string { return strings.TrimRight(f.srv.URL, "/") + "/" + testRealmID }

// drainSessions runs ListSessions and returns the first error it yields.
func drainSessions(ctx context.Context, r *Realm, userID string) error {
	for _, err := range r.Auth.ListSessions(ctx, ListSessionsRequest{UserID: userID}) {
		if err != nil {
			return err
		}
	}
	return nil
}
