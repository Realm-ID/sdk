package gsm

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	realmid "github.com/Realm-ID/sdk/go"
)

// SPEC14_13_gsm: the GSM add-on is a WritableShareSource over an injectable client; the secret is
// either the plaintext bundle (GSM encrypts at rest) or an envelope v1 under a KEK (R93).

const secretName = "projects/p/secrets/realm-shares"

// fakeClient is an in-process Secret Manager: versions are 1, 2, 3 ...
type fakeClient struct {
	mu       sync.Mutex
	versions [][]byte
	loadErr  error
	addErr   error
}

func (f *fakeClient) AccessLatest(_ context.Context, name string) ([]byte, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.loadErr != nil {
		return nil, "", f.loadErr
	}
	if name != secretName {
		return nil, "", errors.New("wrong secret " + name)
	}
	if len(f.versions) == 0 {
		return nil, "", errors.New("secret has no versions")
	}
	return f.versions[len(f.versions)-1], itoa(len(f.versions)), nil
}

func (f *fakeClient) AddVersion(_ context.Context, name string, data []byte) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.addErr != nil {
		return "", f.addErr
	}
	if name != secretName {
		return "", errors.New("wrong secret " + name)
	}
	f.versions = append(f.versions, append([]byte(nil), data...))
	return itoa(len(f.versions)), nil
}

func itoa(i int) string { return string(rune('0' + i)) }

func bundle(realm, dPartner string) *realmid.ShareBundle {
	return &realmid.ShareBundle{Realm: realm, Shares: map[string]realmid.ShareEntry{
		"split-1": {N: "bm4", E: "AQAB", DPartner: dPartner},
	}}
}

func kek(b byte) []byte {
	k := make([]byte, 32)
	for i := range k {
		k[i] = b
	}
	return k
}

func TestGSM_ImplementsWritableShareSource(t *testing.T) {
	src, err := New(Options{Client: &fakeClient{}, Secret: secretName, Realm: "r1"})
	if err != nil {
		t.Fatal(err)
	}
	var _ realmid.WritableShareSource = src
}

func TestGSM_WriteBackThenLoadRoundTrips_VersionIsTheSecretVersion(t *testing.T) {
	fc := &fakeClient{}
	src, err := New(Options{Client: fc, Secret: secretName, Realm: "r1"})
	if err != nil {
		t.Fatal(err)
	}
	v1, err := src.Store(context.Background(), bundle("r1", "ZDE"))
	if err != nil || v1 != "1" {
		t.Fatalf("Store: v=%q err=%v", v1, err)
	}
	got, ver, err := src.Load(context.Background())
	if err != nil || ver != v1 || got.Shares["split-1"].DPartner != "ZDE" || got.Realm != "r1" {
		t.Fatalf("Load: %v ver=%q err=%v", got, ver, err)
	}
	v2, _ := src.Store(context.Background(), bundle("r1", "ZDI"))
	if v2 == v1 {
		t.Error("version did not change on write")
	}
	if _, ver, _ := src.Load(context.Background()); ver != v2 {
		t.Errorf("Load after second write: ver=%q want %q", ver, v2)
	}
}

func TestGSM_KEKSealsAsEnvelopeV1_NoPlaintextShareAtRest(t *testing.T) {
	fc := &fakeClient{}
	k := kek(7)
	src, err := New(Options{Client: fc, Secret: secretName, Realm: "r1", KEK: k})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := src.Store(context.Background(), bundle("r1", "SECRETSHARE")); err != nil {
		t.Fatal(err)
	}
	raw := fc.versions[0]
	if strings.Contains(string(raw), "SECRETSHARE") {
		t.Fatal("share stored in plaintext under a KEK")
	}
	var env map[string]any
	if json.Unmarshal(raw, &env) != nil || env["v"] != float64(1) || env["alg"] != "A256GCM" {
		t.Fatalf("not an envelope v1: %s", raw)
	}
	sum := sha256.Sum256(append([]byte("realmid-kek-id/v1"), k...))
	if env["kek_id"] != hex.EncodeToString(sum[:])[:16] {
		t.Errorf("kek_id %v is not the derived id", env["kek_id"])
	}
	got, _, err := src.Load(context.Background())
	if err != nil || got.Shares["split-1"].DPartner != "SECRETSHARE" {
		t.Fatalf("Load: %v err=%v", got, err)
	}
}

func TestGSM_KEKRefusals_WrongKEKWrongRealmPlaintext(t *testing.T) {
	fc := &fakeClient{}
	w, _ := New(Options{Client: fc, Secret: secretName, Realm: "r1", KEK: kek(7)})
	if _, err := w.Store(context.Background(), bundle("r1", "SECRETSHARE")); err != nil {
		t.Fatal(err)
	}
	for name, o := range map[string]Options{
		"wrong KEK":   {Client: fc, Secret: secretName, Realm: "r1", KEK: kek(8)},
		"wrong realm": {Client: fc, Secret: secretName, Realm: "r2", KEK: kek(7)},
		"no KEK":      {Client: fc, Secret: secretName, Realm: "r1"},
	} {
		s, err := New(o)
		if err != nil {
			t.Fatalf("%s: New: %v", name, err)
		}
		_, _, err = s.Load(context.Background())
		if err == nil {
			t.Errorf("%s: Load succeeded", name)
		} else if strings.Contains(err.Error(), "SECRETSHARE") {
			t.Errorf("%s: error echoes the share: %v", name, err)
		}
	}
}

func TestGSM_OpensAnEnvelopeTheCoreFileStoreWrote(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shares.json")
	f, err := realmid.NewFileShareSource(path, realmid.FileShareOptions{KEK: kek(9), Realm: "r1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Store(context.Background(), bundle("r1", "FROMFILE")); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	fc := &fakeClient{versions: [][]byte{raw}}
	s, _ := New(Options{Client: fc, Secret: secretName, Realm: "r1", KEK: kek(9)})
	got, _, err := s.Load(context.Background())
	if err != nil || got.Shares["split-1"].DPartner != "FROMFILE" {
		t.Fatalf("cross-format Load: %v err=%v", got, err)
	}
	// and the reverse: what the add-on writes, the core file store opens
	if _, err := s.Store(context.Background(), bundle("r1", "FROMGSM")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, fc.versions[1], 0o600); err != nil {
		t.Fatal(err)
	}
	back, _, err := f.Load(context.Background())
	if err != nil || back.Shares["split-1"].DPartner != "FROMGSM" {
		t.Fatalf("core Load of an add-on envelope: %v err=%v", back, err)
	}
}

func TestGSM_ClientErrorsAreWrappedAndKeepTheCause(t *testing.T) {
	boom := errors.New("rpc unavailable")
	fc := &fakeClient{loadErr: boom, addErr: boom}
	s, _ := New(Options{Client: fc, Secret: secretName, Realm: "r1"})
	if _, _, err := s.Load(context.Background()); !errors.Is(err, boom) || err.Error() == boom.Error() {
		t.Errorf("Load error not wrapped with context: %v", err)
	}
	if _, err := s.Store(context.Background(), bundle("r1", "x")); !errors.Is(err, boom) || err.Error() == boom.Error() {
		t.Errorf("Store error not wrapped with context: %v", err)
	}
}

func TestGSM_ConfigRefusals(t *testing.T) {
	good := Options{Client: &fakeClient{}, Secret: secretName, Realm: "r1"}
	if _, err := New(good); err != nil { // control
		t.Fatal(err)
	}
	for name, mut := range map[string]func(*Options){
		"no client": func(o *Options) { o.Client = nil },
		"no secret": func(o *Options) { o.Secret = "" },
		"no realm":  func(o *Options) { o.Realm = "" },
		"short KEK": func(o *Options) { o.KEK = []byte("short") },
	} {
		o := good
		mut(&o)
		if _, err := New(o); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}
