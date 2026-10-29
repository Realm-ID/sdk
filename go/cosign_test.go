package realmid

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"strings"
	"testing"
)

type vecFile struct {
	Key struct {
		N        string `json:"n"`
		E        int    `json:"e"`
		DPartner string `json:"d_partner"`
	} `json:"key"`
	JWTCases []struct {
		Name         string `json:"name"`
		HeaderJSON   string `json:"header_json"`
		PayloadJSON  string `json:"payload_json"`
		SigningInput string `json:"signing_input"`
		SRI          string `json:"s_ri"`
		S            string `json:"s"`
		JWT          string `json:"jwt"`
	} `json:"jwt_cases"`
	Handshake struct {
		Realm, KID, Nonce string
		Message           string `json:"message"`
		SRI               string `json:"s_ri"`
		S                 string `json:"s"`
	} `json:"handshake"`
	Downgrade struct {
		Realm, KID, Nonce, Preimage string
		Message                     string `json:"message"`
		SRI                         string `json:"s_ri"`
		S                           string `json:"s"`
	} `json:"downgrade"`
	Negative []struct {
		Name        string `json:"name"`
		RejectedJWT string `json:"rejected_jwt"`
		SRI         string `json:"s_ri"`
	} `json:"negative_cases"`
}

func loadVectors(t *testing.T) (*vecFile, ShareEntry, *rsa.PublicKey) {
	t.Helper()
	raw, err := os.ReadFile("../testdata/split-vectors/vectors.json")
	if err != nil {
		t.Fatalf("vectors: %v", err)
	}
	var v vecFile
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	h := func(s string) *big.Int { b, _ := hex.DecodeString(s); return new(big.Int).SetBytes(b) }
	n := h(v.Key.N)
	e := big.NewInt(int64(v.Key.E))
	return &v, ShareEntry{N: b64big(n), E: b64big(e), DPartner: b64big(h(v.Key.DPartner))}, &rsa.PublicKey{N: n, E: v.Key.E}
}

func hexb(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// SPEC14_3_cosign: every vector signature verifies under crypto/rsa (guards the fixtures; green today).
func TestCosign_EveryVectorSignatureVerifiesWithRSAVerifyPKCS1v15(t *testing.T) {
	v, _, pub := loadVectors(t)
	if len(v.JWTCases) != 5 {
		t.Fatalf("examined %d jwt cases, want 5", len(v.JWTCases))
	}
	for _, c := range v.JWTCases {
		sum := sha256.Sum256([]byte(c.SigningInput))
		if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], hexb(t, c.S)); err != nil {
			t.Errorf("%s: %v", c.Name, err)
		}
	}
	hs := hexb(t, v.Handshake.Message)
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, hs, hexb(t, v.Handshake.S)); err != nil {
		t.Errorf("handshake: %v", err)
	}
	for _, n := range v.Negative {
		parts := strings.Split(n.RejectedJWT, ".")
		sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
		sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
		if rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], sig) == nil {
			t.Errorf("negative %s verifies", n.Name)
		}
	}
}

func TestCosign_CompletePartialReproducesEveryVectorSignature(t *testing.T) {
	v, entry, pub := loadVectors(t)
	for _, c := range v.JWTCases {
		sig, err := CompletePartial(entry, c.SigningInput, hexb(t, c.SRI))
		if err != nil {
			t.Errorf("%s: CompletePartial: %v", c.Name, err)
			continue
		}
		if hex.EncodeToString(sig) != c.S {
			t.Errorf("%s: combined signature differs from vector s", c.Name)
		}
		sum := sha256.Sum256([]byte(c.SigningInput))
		if rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], sig) != nil {
			t.Errorf("%s: result does not verify under crypto/rsa", c.Name)
		}
	}
}

func TestCosign_CompletePartialRefusesCorruptOrWrongPartials(t *testing.T) {
	v, entry, _ := loadVectors(t)
	c := v.JWTCases[0]
	bad := hexb(t, c.SRI)
	bad[100] ^= 0x01
	if sig, err := CompletePartial(entry, c.SigningInput, bad); err == nil || sig != nil {
		t.Errorf("corrupted partial_ri: want refusal and no signature, got sig=%v err=%v", sig != nil, err)
	}
	if sig, err := CompletePartial(entry, c.SigningInput, make([]byte, 256)); err == nil || sig != nil {
		t.Errorf("zero partial_ri: want refusal, got err=%v", err)
	}
	// a partial for a DIFFERENT message must not complete this one
	other := v.JWTCases[1]
	if _, err := CompletePartial(entry, c.SigningInput, hexb(t, other.SRI)); err == nil {
		t.Errorf("partial_ri of another message accepted")
	}
}

// The downgrade challenge (SPEC 14.6) is the same exponentiation over its own purpose-bound preimage.
func TestCosign_DowngradeVector(t *testing.T) {
	v, entry, pub := loadVectors(t)
	d := v.Downgrade
	pre := "realmid-split-downgrade/v1|" + d.Realm + "|" + d.KID + "|" + d.Nonce
	if d.Preimage != pre {
		t.Fatalf("preimage = %q, want %q", d.Preimage, pre)
	}
	sig, err := CompletePartial(entry, pre, hexb(t, d.SRI))
	if err != nil {
		t.Fatalf("CompletePartial: %v", err)
	}
	if hex.EncodeToString(sig) != d.S {
		t.Errorf("downgrade signature differs from vector")
	}
	if rsa.VerifyPKCS1v15(pub, crypto.SHA256, hexb(t, d.Message), sig) != nil {
		t.Errorf("downgrade signature does not verify")
	}
	if _, err := CompleteHandshake(entry, d.Realm, d.KID, d.Nonce, hexb(t, d.SRI)); err == nil {
		t.Errorf("a downgrade partial was accepted as a handshake (purposes must not cross)")
	}
}

func TestCosign_HandshakeVector(t *testing.T) {
	v, entry, pub := loadVectors(t)
	h := v.Handshake
	sig, err := CompleteHandshake(entry, h.Realm, h.KID, h.Nonce, hexb(t, h.SRI))
	if err != nil {
		t.Fatalf("CompleteHandshake: %v", err)
	}
	if hex.EncodeToString(sig) != h.S {
		t.Errorf("handshake signature differs from vector")
	}
	if rsa.VerifyPKCS1v15(pub, crypto.SHA256, hexb(t, h.Message), sig) != nil {
		t.Errorf("handshake signature does not verify")
	}
}

func TestCosign_CoSignReleasesBasicVectorJWT(t *testing.T) {
	v, entry, _ := loadVectors(t)
	c := v.JWTCases[0] // basic: typ JWT, iss https://auth.realmid.dev/r1
	h, p, _ := strings.Cut(c.SigningInput, ".")
	got, err := CoSign(entry, "https://auth.realmid.dev/r1", PartialSigning{
		KID: "k1", Header: h, Payload: p, PartialRI: base64.RawURLEncoding.EncodeToString(hexb(t, c.SRI))})
	if err != nil {
		t.Fatalf("CoSign: %v", err)
	}
	if got != c.JWT {
		t.Errorf("jwt differs from vector:\n got %s\nwant %s", got, c.JWT)
	}
}

func TestCosign_RefusesForeignIssuerAndTyp(t *testing.T) {
	k := newSplitKey(t, "k1")
	mk := func(hdrTyp, iss string) PartialSigning {
		hb, _ := json.Marshal(map[string]any{"alg": "RS256", "typ": hdrTyp, "kid": "k1"})
		cb, _ := json.Marshal(map[string]any{"iss": iss, "sub": "u"})
		h, p := base64.RawURLEncoding.EncodeToString(hb), base64.RawURLEncoding.EncodeToString(cb)
		sum := sha256.Sum256([]byte(h + "." + p))
		return PartialSigning{KID: "k1", Header: h, Payload: p,
			PartialRI: base64.RawURLEncoding.EncodeToString(k.riPartial(t, sum[:]))}
	}
	if tok, err := CoSign(k.entry(), "https://auth.example/r1", mk("JWT", "https://auth.example/r1")); err != nil || tok == "" {
		t.Fatalf("control (good iss/typ) refused: %v", err)
	}
	if tok, err := CoSign(k.entry(), "https://auth.example/r1", mk("JWT", "https://evil.example/r1")); err == nil || tok != "" {
		t.Errorf("foreign iss: want refusal with no token, got err=%v tok=%q", err, tok)
	}
	if tok, err := CoSign(k.entry(), "https://auth.example/r1", mk("at+evil", "https://auth.example/r1")); err == nil || tok != "" {
		t.Errorf("foreign typ: want refusal with no token, got err=%v", err)
	}
}

func TestCosign_VerifyBeforeRelease_WrongShareYieldsNoToken(t *testing.T) {
	k := newSplitKey(t, "k1")
	other := newSplitKey(t, "k1") // partner holds a share of a DIFFERENT key
	h, p := k.signingInput(userClaims("https://auth.example/r1"))
	sum := sha256.Sum256([]byte(h + "." + p))
	tok, err := CoSign(other.entry(), "https://auth.example/r1", PartialSigning{KID: "k1", Header: h, Payload: p,
		PartialRI: base64.RawURLEncoding.EncodeToString(k.riPartial(t, sum[:]))})
	if err == nil || tok != "" {
		t.Errorf("mismatched share: want refusal and empty token, got err=%v tok=%q", err, tok)
	}
}

func TestCosign_ShareNeverPrintedByFormatVerbs(t *testing.T) {
	k := newSplitKey(t, "k1")
	e := k.entry()
	b := k.bundle("r1")
	for _, s := range []string{fmt.Sprintf("%v", e), fmt.Sprintf("%+v", e), fmt.Sprintf("%#v", e),
		fmt.Sprintf("%v", b), fmt.Sprintf("%+v", b), fmt.Sprintf("%#v", &b)} {
		if strings.Contains(s, e.DPartner) {
			t.Errorf("a format verb printed d_partner: %.60s...", s)
		}
	}
}

// SPEC14_2_partial: realm.Auth.Token on a split realm calls /auth/token/partial, finishes the
// signature, verifies it, stores the rotated refresh token for a people call.
func TestCosign_SplitRealmTokenUsesPartialEndpointAndFinishes(t *testing.T) {
	k := newSplitKey(t, "split-1")
	f := newFakeIssuer(t)
	claims := userClaims(issuerOf(f))
	f.on("/auth/token/partial", func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		jsonReply(w, 200, k.partialAnswer(t, claims, "rt-rotated"))
	})
	f.on("/auth/token", func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		t.Errorf("a split realm minted a user token at /auth/token")
		jsonReply(w, 409, map[string]any{"error": map[string]any{"code": "split_signing_required"}})
	})
	r := f.realm(t, func(c *Config) { c.Split = true; c.ShareSource = &memShares{b: k.bundle(testRealmID)} })
	out, err := r.Auth.Token(context.Background(), TokenRequest{RefreshToken: "rt-old", TenantID: "t1"})
	if err != nil {
		t.Fatalf("Token: %v", err)
	}
	if out.RefreshToken != "rt-rotated" {
		t.Errorf("rotated refresh token not stored: %q", out.RefreshToken)
	}
	parts := strings.Split(out.AccessToken, ".")
	if len(parts) != 3 {
		t.Fatalf("access token is not a finished JWT: %q", out.AccessToken)
	}
	sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if rsa.VerifyPKCS1v15(&k.priv.PublicKey, crypto.SHA256, sum[:], sig) != nil {
		t.Errorf("finished token does not verify under the split key")
	}
	pr := f.reqs("/auth/token/partial")
	if len(pr) != 1 || pr[0].Auth != "Bearer ptok" || pr[0].Body["refresh_token"] != "rt-old" {
		t.Errorf("partial request wrong: %+v", pr)
	}
}

func TestCosign_SplitRealmCorruptPartialReleasesNoToken(t *testing.T) {
	k := newSplitKey(t, "split-1")
	f := newFakeIssuer(t)
	f.on("/auth/token/partial", func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		a := k.partialAnswer(t, userClaims(issuerOf(f)), "rt2")
		a["signing"].(map[string]any)["partial_ri"] = base64.RawURLEncoding.EncodeToString(make([]byte, 256))
		jsonReply(w, 200, a)
	})
	r := f.realm(t, func(c *Config) { c.Split = true; c.ShareSource = &memShares{b: k.bundle(testRealmID)} })
	out, err := r.Auth.Token(context.Background(), TokenRequest{RefreshToken: "rt", TenantID: "t1"})
	if err == nil || (out != nil && out.AccessToken != "") {
		t.Errorf("corrupt partial: want error and no access token, got err=%v out=%+v", err, out)
	}
}
