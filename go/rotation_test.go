package realmid

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"math/big"
	"net/http"
	"testing"
)

// SPEC14_12_ci_rotation / 14.5: self-rotation on a writable store. The handshake wire shape
// ({nonce, partial_ri} out, {sig} in) is [inferred] from the vectors README; swagger says only
// "returns a challenge".

func splitRoutes(f *fakeIssuer, handshakeOK bool) (uploads *[]map[string]any) {
	var ups []map[string]any
	base := "/platforms/" + testRealmID + "/signing-keys/split"
	f.on(base+"/rotation-lease", func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		jsonReply(w, 200, map[string]any{"lease": "l1"})
	})
	f.on(base, func(w http.ResponseWriter, _ *http.Request, body map[string]any) {
		ups = append(ups, body)
		jsonReply(w, 200, map[string]any{"status": "uploaded"})
	})
	f.on(base+"/k2/handshake", func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		// the fake RI holds d_ri from the upload and half-signs the SDK-recomputable message
		up := ups[len(ups)-1]
		n := new(big.Int).SetBytes(dec(up["n"].(string)))
		dRI := new(big.Int).SetBytes(dec(up["d_ri"].(string)))
		nonce := "bm9uY2U"
		msg := sha256.Sum256([]byte("realmid-split-handshake/v1|" + testRealmID + "|k2|" + nonce))
		m := emsaFromDigest(n, up, msg[:])
		w.Header().Set("Content-Type", "application/json")
		jsonReply(w, 200, map[string]any{"nonce": nonce,
			"partial_ri": base64.RawURLEncoding.EncodeToString(new(big.Int).Exp(m, dRI, n).FillBytes(make([]byte, 256)))})
	})
	f.on(base+"/k2/handshake/complete", func(w http.ResponseWriter, _ *http.Request, body map[string]any) {
		if !handshakeOK {
			jsonReply(w, 401, map[string]any{"error": map[string]any{"code": "handshake_failed", "message": "no"}})
			return
		}
		jsonReply(w, 200, map[string]any{"status": "ok"})
	})
	return &ups
}

func dec(s string) []byte { b, _ := base64.RawURLEncoding.DecodeString(s); return b }

// emsaFromDigest recovers m for a key known only by (n, e) by PKCS#1 v1.5 padding by hand.
func emsaFromDigest(n *big.Int, up map[string]any, digest []byte) *big.Int {
	prefix := []byte{0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20}
	tLen := len(prefix) + len(digest)
	em := make([]byte, 256)
	em[1] = 0x01
	for i := 2; i < 256-tLen-1; i++ {
		em[i] = 0xff
	}
	copy(em[256-tLen:], append(append([]byte{}, prefix...), digest...))
	return new(big.Int).SetBytes(em)
}

func TestRotation_FileStoreHappyPathOrderAndNoActor(t *testing.T) {
	f := newFakeIssuer(t)
	ups := splitRoutes(f, true)
	old := newSplitKey(t, "k1")
	src, err := NewFileShareSource(t.TempDir()+"/s.json", FileShareOptions{LocalDev: true})
	if err != nil {
		t.Fatalf("file source: %v", err)
	}
	if _, err := src.Store(context.Background(), old.bundle(testRealmID)); err != nil {
		t.Fatal(err)
	}
	r := f.realm(t, nil)
	if err := r.SigningKeys.RotateSplit(context.Background(), src, RotateSplitOptions{KID: "k2"}); err != nil {
		t.Fatalf("RotateSplit: %v", err)
	}
	base := "POST /platforms/" + testRealmID + "/signing-keys/split"
	want := []string{base + "/rotation-lease", "POST " + base[5:], base[:len(base)] + "/k2/handshake", base + "/k2/handshake/complete"}
	got := f.paths()
	var seq []string
	for _, p := range got {
		if p != "POST /auth/token" && p != "GET /platforms/mine" {
			seq = append(seq, p)
		}
	}
	if len(seq) != 4 {
		t.Fatalf("call sequence = %v, want %v", seq, want)
	}
	for i := range want {
		if seq[i] != want[i] {
			t.Errorf("step %d = %q, want %q", i, seq[i], want[i])
		}
	}
	for _, s := range f.seen {
		if s.Path != "/auth/token" && s.Path != "/platforms/mine" && (s.Auth != "Bearer ptok" || s.UserToken != "") {
			t.Errorf("%s: auth=%q user-token=%q; rotation is platform token, no actor (R67.3)", s.Path, s.Auth, s.UserToken)
		}
	}
	if len(*ups) != 1 {
		t.Fatalf("uploads = %d", len(*ups))
	}
	b, _, _ := src.Load(context.Background())
	e, ok := b.Shares["k2"]
	if !ok {
		t.Fatal("new share not stored")
	}
	// d_ri + d_partner must be a working private exponent for (n, e)
	n := new(big.Int).SetBytes(dec(e.N))
	d := new(big.Int).Add(new(big.Int).SetBytes(dec((*ups)[0]["d_ri"].(string))), new(big.Int).SetBytes(dec(e.DPartner)))
	m := big.NewInt(123456789)
	s := new(big.Int).Exp(m, d, n)
	if new(big.Int).Exp(s, big.NewInt(65537), n).Cmp(m) != 0 {
		t.Error("d_ri + d_partner is not the private exponent of the uploaded public key")
	}
	if len(b.Previous) != 1 || b.Previous[0].KID != "k1" || b.Previous[0].TrustUntil == 0 {
		t.Errorf("rotation must keep k1 as previous with trust_until: %+v", b.Previous)
	}
	_ = crypto.SHA256
	_ = rsa.PublicKey{}
}

func TestRotation_RecoveryKeepsNoPreviousKey(t *testing.T) {
	f := newFakeIssuer(t)
	splitRoutes(f, true)
	src := &memShares{b: newSplitKey(t, "k1").bundle(testRealmID)}
	if err := f.realm(t, nil).SigningKeys.RotateSplit(context.Background(), src, RotateSplitOptions{KID: "k2", Recovery: true}); err != nil {
		t.Fatalf("RotateSplit(recovery): %v", err)
	}
	if len(src.b.Previous) != 0 {
		t.Errorf("recovery = no overlap, but previous = %+v", src.b.Previous)
	}
}

func TestRotation_HandshakeFailureStopsAndDoesNotLoop(t *testing.T) {
	f := newFakeIssuer(t)
	splitRoutes(f, false)
	src := &memShares{b: newSplitKey(t, "k1").bundle(testRealmID)}
	err := f.realm(t, nil).SigningKeys.RotateSplit(context.Background(), src, RotateSplitOptions{KID: "k2"})
	if err == nil {
		t.Fatal("handshake failure returned nil")
	}
	base := "/platforms/" + testRealmID + "/signing-keys/split"
	if n := len(f.reqs(base + "/k2/handshake/complete")); n != 1 {
		t.Errorf("handshake/complete called %d times; want exactly 1 (stop, never loop)", n)
	}
	if n := len(f.reqs(base)); n != 1 {
		t.Errorf("upload called %d times; want 1", n)
	}
}

func TestRotation_LeaseHeldStopsBeforeKeygenOrUpload(t *testing.T) {
	f := newFakeIssuer(t)
	base := "/platforms/" + testRealmID + "/signing-keys/split"
	f.on(base+"/rotation-lease", func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		jsonReply(w, 409, map[string]any{"error": map[string]any{"code": "rotation_lease_held", "message": "held"}})
	})
	src := &memShares{b: newSplitKey(t, "k1").bundle(testRealmID)}
	if err := f.realm(t, nil).SigningKeys.RotateSplit(context.Background(), src, RotateSplitOptions{KID: "k2"}); err == nil {
		t.Fatal("lease held: want error")
	}
	if n := len(f.reqs(base)); n != 0 {
		t.Errorf("uploaded %d times despite a held lease", n)
	}
	if _, ok := src.b.Shares["k2"]; ok {
		t.Error("stored a new share despite a held lease")
	}
}

func TestRotation_EnvSourceCannotRotateAndSendsNothing(t *testing.T) {
	f := newFakeIssuer(t)
	t.Setenv("RI_TEST_SHARE_BUNDLE", `{"realm":"r","shares":{}}`)
	err := f.realm(t, nil).SigningKeys.RotateSplit(context.Background(), NewEnvShareSource("RI_TEST_SHARE_BUNDLE"), RotateSplitOptions{KID: "k2"})
	if err == nil {
		t.Fatal("env source rotation: want error (read-only; rotation_due path)")
	}
	for _, p := range f.paths() {
		if p != "POST /auth/token" {
			t.Errorf("env-source rotation sent %s", p)
		}
	}
}
