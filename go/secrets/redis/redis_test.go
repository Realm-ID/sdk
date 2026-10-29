package redis

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	realmid "github.com/Realm-ID/sdk/go"
)

// SPEC14_13_redis: keys realmid:share:<realm>:bundle|public|version, envelope v1 under a KEK (the
// FIRST KEK writes, any listed KEK reads), persistence required (R39(2)), a publish on every write.

type fakeClient struct {
	mu         sync.Mutex
	kv         map[string]string
	published  []string // "channel|message"
	persistent bool
	setErr     error
	getErr     error
	setOrder   []string
}

func newFake() *fakeClient { return &fakeClient{kv: map[string]string{}, persistent: true} }

func (f *fakeClient) Get(_ context.Context, key string) (string, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.getErr != nil {
		return "", false, f.getErr
	}
	v, ok := f.kv[key]
	return v, ok, nil
}

func (f *fakeClient) Set(_ context.Context, key, value string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.setErr != nil {
		return f.setErr
	}
	f.kv[key] = value
	f.setOrder = append(f.setOrder, key)
	return nil
}

func (f *fakeClient) Publish(_ context.Context, ch, msg string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.published = append(f.published, ch+"|"+msg)
	return nil
}

func (f *fakeClient) Persistent(context.Context) (bool, error) { return f.persistent, nil }

func kek(b byte) []byte {
	k := make([]byte, 32)
	for i := range k {
		k[i] = b
	}
	return k
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func bundle(realm, d string) *realmid.ShareBundle {
	return &realmid.ShareBundle{Realm: realm, Shares: map[string]realmid.ShareEntry{
		"split-1": {N: "bm4", E: "AQAB", DPartner: d},
	}, Previous: []realmid.PreviousKey{{KID: "old", N: "b2xk", E: "AQAB", TrustUntil: 99}}}
}

func mk(t *testing.T, f *fakeClient, keks ...[]byte) realmid.WritableShareSource {
	t.Helper()
	s, err := New(context.Background(), Options{Client: f, Realm: "r1", KEKs: keks})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestRedis_WriteBackLaysOutTheThreeKeysAndPublishesTheVersion(t *testing.T) {
	f := newFake()
	s := mk(t, f, kek(1))
	ver, err := s.Store(context.Background(), bundle("r1", "SECRETSHARE"))
	if err != nil || ver == "" {
		t.Fatalf("Store: ver=%q err=%v", ver, err)
	}
	for _, k := range []string{"realmid:share:r1:bundle", "realmid:share:r1:public", "realmid:share:r1:version"} {
		if _, ok := f.kv[k]; !ok {
			t.Errorf("missing key %s", k)
		}
	}
	if f.kv["realmid:share:r1:version"] != ver {
		t.Errorf("version key %q != returned %q", f.kv["realmid:share:r1:version"], ver)
	}
	// the version key is written LAST: a watcher that sees the new version finds the new bundle
	if got := f.setOrder[len(f.setOrder)-1]; got != "realmid:share:r1:version" {
		t.Errorf("last write was %s, want the version key", got)
	}
	if len(f.published) != 1 || f.published[0] != "realmid:share:r1:version|"+ver {
		t.Errorf("published = %v", f.published)
	}
	for k, v := range f.kv {
		if strings.Contains(v, "SECRETSHARE") {
			t.Errorf("share in plaintext under %s", k)
		}
	}
	var pub map[string]any
	if err := json.Unmarshal([]byte(f.kv["realmid:share:r1:public"]), &pub); err != nil {
		t.Fatalf("public key is not JSON: %v", err)
	}
}

func TestRedis_LoadRoundTripsAndTheEnvelopeCarriesVer(t *testing.T) {
	f := newFake()
	s := mk(t, f, kek(1))
	ver, _ := s.Store(context.Background(), bundle("r1", "ZDE"))
	got, lv, err := s.Load(context.Background())
	if err != nil || lv != ver || got.Shares["split-1"].DPartner != "ZDE" || len(got.Previous) != 1 {
		t.Fatalf("Load: %v ver=%q err=%v", got, lv, err)
	}
	var env map[string]any
	_ = json.Unmarshal([]byte(f.kv["realmid:share:r1:bundle"]), &env)
	if env["v"] != float64(1) || env["alg"] != "A256GCM" || env["ver"] != ver {
		t.Errorf("envelope = %v", env)
	}
	ver2, _ := s.Store(context.Background(), bundle("r1", "ZDI"))
	if ver2 == ver {
		t.Error("version did not change on write")
	}
}

func TestRedis_KEKRotation_FirstWritesAnyReads(t *testing.T) {
	f := newFake()
	old := mk(t, f, kek(1))
	if _, err := old.Store(context.Background(), bundle("r1", "ZDE")); err != nil {
		t.Fatal(err)
	}
	rotated := mk(t, f, kek(2), kek(1)) // new key first (write), old key still reads
	got, _, err := rotated.Load(context.Background())
	if err != nil || got.Shares["split-1"].DPartner != "ZDE" {
		t.Fatalf("Load under the retired KEK: %v err=%v", got, err)
	}
	if _, err := rotated.Store(context.Background(), bundle("r1", "ZDI")); err != nil {
		t.Fatal(err)
	}
	var env map[string]any
	_ = json.Unmarshal([]byte(f.kv["realmid:share:r1:bundle"]), &env)
	if env["kek_id"] != KEKID(kek(2)) {
		t.Errorf("rewrite sealed under %v, want the first KEK %s", env["kek_id"], KEKID(kek(2)))
	}
	if _, _, err := old.Load(context.Background()); err == nil {
		t.Error("the retired-KEK-only source still loads after the rewrite")
	}
}

func TestRedis_Refusals(t *testing.T) {
	ctx := context.Background()
	f := newFake()
	s := mk(t, f, kek(1))
	if _, _, err := s.Load(ctx); err == nil { // nothing stored yet
		t.Error("Load of an absent bundle succeeded")
	}
	if _, err := s.Store(ctx, bundle("r1", "SECRETSHARE")); err != nil {
		t.Fatal(err)
	}
	for name, o := range map[string]Options{
		"wrong KEK":   {Client: f, Realm: "r1", KEKs: [][]byte{kek(5)}},
		"wrong realm": {Client: f, Realm: "r2", KEKs: [][]byte{kek(1)}},
	} {
		x, err := New(ctx, o)
		if err != nil {
			t.Fatalf("%s: New: %v", name, err)
		}
		if _, _, err := x.Load(ctx); err == nil {
			t.Errorf("%s: Load succeeded", name)
		} else if strings.Contains(err.Error(), "SECRETSHARE") {
			t.Errorf("%s: error echoes the share", name)
		}
	}
}

func TestRedis_PersistenceRequired(t *testing.T) {
	f := newFake()
	if _, err := New(context.Background(), Options{Client: f, Realm: "r1", KEKs: [][]byte{kek(1)}}); err != nil { // control
		t.Fatal(err)
	}
	f.persistent = false
	if _, err := New(context.Background(), Options{Client: f, Realm: "r1", KEKs: [][]byte{kek(1)}}); err == nil {
		t.Error("a Redis with no persistence was accepted")
	}
}

func TestRedis_ConfigRefusals(t *testing.T) {
	good := Options{Client: newFake(), Realm: "r1", KEKs: [][]byte{kek(1)}}
	if _, err := New(context.Background(), good); err != nil { // control
		t.Fatal(err)
	}
	for name, mut := range map[string]func(*Options){
		"no client": func(o *Options) { o.Client = nil },
		"no realm":  func(o *Options) { o.Realm = "" },
		"no KEK":    func(o *Options) { o.KEKs = nil },
		"short KEK": func(o *Options) { o.KEKs = [][]byte{[]byte("short")} },
	} {
		o := good
		mut(&o)
		if _, err := New(context.Background(), o); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

func TestRedis_ClientErrorsWrappedKeepCause(t *testing.T) {
	boom := errors.New("conn reset")
	f := newFake()
	s := mk(t, f, kek(1))
	f.setErr, f.getErr = boom, boom
	if _, _, err := s.Load(context.Background()); !errors.Is(err, boom) || err.Error() == boom.Error() {
		t.Errorf("Load: %v", err)
	}
	if _, err := s.Store(context.Background(), bundle("r1", "x")); !errors.Is(err, boom) || err.Error() == boom.Error() {
		t.Errorf("Store: %v", err)
	}
	if len(f.published) != 0 {
		t.Error("published a version although the write failed")
	}
}

func TestParseKEKList_FromTheEnvVarShape(t *testing.T) {
	// REALM_ID_SHARE_KEK: <b64url 32 bytes>[,<b64url 32 bytes>...], the FIRST is the write key.
	got, err := ParseKEKList(b64(kek(1)) + "," + b64(kek(2)))
	if err != nil || len(got) != 2 || got[0][0] != 1 || got[1][0] != 2 {
		t.Fatalf("ParseKEKList: %v err=%v", got, err)
	}
	for _, bad := range []string{"", ",", b64(kek(1)) + ",", "!!!", "c2hvcnQ"} {
		if _, err := ParseKEKList(bad); err == nil {
			t.Errorf("ParseKEKList(%q) succeeded", bad)
		}
	}
}
