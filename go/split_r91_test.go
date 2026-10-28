package realmid

// R91-R95 (SPEC §14.4, §14.5, §14.8, §14.9): previous-key trust window, lease reason, envelope v1,
// construction rule, local codes, handler clientKey.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func rotateAt(t *testing.T, observedExpiresIn int, opts RotateSplitOptions) (*memShares, *fakeIssuer, time.Time) {
	t.Helper()
	f := newFakeIssuer(t)
	splitRoutes(f, true)
	old := newSplitKey(t, "k1")
	now := time.Now()
	src := &memShares{b: old.bundle(testRealmID)}
	r := f.realm(t, func(c *Config) {
		c.Clock = func() time.Time { return now }
		c.Split = true
		c.ShareSource = src
	})
	if observedExpiresIn > 0 {
		f.on("/auth/token/partial", func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
			a := old.partialAnswer(t, userClaims(issuerOf(f)), "rt2")
			a["expires_in"] = observedExpiresIn
			jsonReply(w, 200, a)
		})
		if _, err := r.Auth.Token(context.Background(), TokenRequest{RefreshToken: "rt", TenantID: "t1"}); err != nil {
			t.Fatalf("observing mint: %v", err)
		}
	}
	opts.KID = "k2"
	if err := r.SigningKeys.RotateSplit(context.Background(), src, opts); err != nil {
		t.Fatalf("RotateSplit: %v", err)
	}
	return src, f, now
}

// R91: a retired key stays trusted for rotation + one access-token lifetime (15 min floor) + 5 min.
func TestR91_PreviousTrustIsFloorPlusSlackWhenNoTokenObserved(t *testing.T) {
	src, _, now := rotateAt(t, 0, RotateSplitOptions{})
	if len(src.b.Previous) != 1 {
		t.Fatalf("previous = %+v", src.b.Previous)
	}
	want := now.Add(20 * time.Minute).Unix()
	if got := src.b.Previous[0].TrustUntil; got != want {
		t.Errorf("trust_until = now%+ds, want now+20m (15 min floor + 5 min slack)", got-now.Unix())
	}
}

func TestR91_PreviousTrustFollowsObservedAccessTokenLifetime(t *testing.T) {
	src, _, now := rotateAt(t, 3600, RotateSplitOptions{})
	want := now.Add(65 * time.Minute).Unix()
	if got := src.b.Previous[0].TrustUntil; got != want {
		t.Errorf("trust_until = now%+ds, want now+65m (observed 1h + 5 min slack)", got-now.Unix())
	}
}

// R92: the lease says why.
func TestR92_LeaseBodyCarriesReason(t *testing.T) {
	for _, tc := range []struct {
		opts RotateSplitOptions
		want string
	}{{RotateSplitOptions{}, "rotation"}, {RotateSplitOptions{Recovery: true}, "recovery"}} {
		_, f, _ := rotateAt(t, 0, tc.opts)
		ls := f.reqs("/platforms/" + testRealmID + "/signing-keys/split/rotation-lease")
		if len(ls) != 1 || ls[0].Body["reason"] != tc.want {
			t.Errorf("lease body = %+v, want reason %q", ls, tc.want)
		}
	}
}

// R93(2): envelope v1.
func TestR93_FileEnvelopeV1HasKEKIDAndBindsRealm(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.json")
	kek := bytes.Repeat([]byte{7}, 32)
	src, err := NewFileShareSource(path, FileShareOptions{KEK: kek, Realm: "r1"})
	if err != nil {
		t.Fatalf("NewFileShareSource: %v", err)
	}
	if _, err := src.Store(context.Background(), newSplitKey(t, "k1").bundle("r1")); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	var env map[string]any
	_ = json.Unmarshal(raw, &env)
	sum := sha256.Sum256(append([]byte("realmid-kek-id/v1"), kek...))
	if env["v"] != float64(1) || env["alg"] != "A256GCM" || env["kek_id"] != hex.EncodeToString(sum[:])[:16] {
		t.Errorf("envelope = %v, want v=1 alg=A256GCM kek_id=%s", env, hex.EncodeToString(sum[:])[:16])
	}
	other, err := NewFileShareSource(path, FileShareOptions{KEK: kek, Realm: "r2"})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := other.Load(context.Background()); err == nil {
		t.Error("a bundle sealed for realm r1 opened under realm r2 (AAD must bind the realm)")
	}
	env["kek_id"] = "0000000000000000"
	tampered, _ := json.Marshal(env)
	_ = os.WriteFile(path, tampered, 0o600)
	if _, _, err := src.Load(context.Background()); err == nil {
		t.Error("an envelope with a foreign kek_id loaded")
	}
}

func TestR93_FileWithKEKNeedsRealm(t *testing.T) {
	_, err := NewFileShareSource(filepath.Join(t.TempDir(), "s.json"), FileShareOptions{KEK: bytes.Repeat([]byte{7}, 32)})
	if err == nil {
		t.Error("a KEK without a Realm must be a construction error (AAD needs the realm)")
	}
}

// §14.9: a ShareSource without Split is a construction error.
func TestR9x_ShareSourceWithoutSplitFailsToConstruct(t *testing.T) {
	f := newFakeIssuer(t)
	_, err := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: f.srv.URL,
		ShareSource: &memShares{b: newSplitKey(t, "k1").bundle(testRealmID)}})
	if err == nil {
		t.Fatal("NewRealm(ShareSource, no Split) succeeded; want a construction error")
	}
}

type failingShares struct{}

func (failingShares) Load(context.Context) (*ShareBundle, string, error) {
	return nil, "", errors.New("store down")
}

func TestR9x_ShareLoadFailureIsShareLoadFailedNotJWKS(t *testing.T) {
	f := newFakeIssuer(t)
	r := f.realm(t, func(c *Config) { c.Split = true; c.ShareSource = failingShares{} })
	k := newSplitKey(t, "k1")
	_, err := r.Verify(context.Background(), k.fullJWT(t, userClaims(issuerOf(f))), nil)
	var re *RealmError
	if !errors.As(err, &re) || re.Code != ErrCodeShareLoadFailed {
		t.Fatalf("want code %q, got %v", ErrCodeShareLoadFailed, err)
	}
}

func TestR9x_ReadOnlySourceRotationIsCodedAndSendsNothing(t *testing.T) {
	f := newFakeIssuer(t)
	t.Setenv("RI_R9X_BUNDLE", `{"realm":"r","shares":{}}`)
	r := f.realm(t, nil)
	err := r.SigningKeys.RotateSplit(context.Background(), NewEnvShareSource("RI_R9X_BUNDLE"), RotateSplitOptions{KID: "k2"})
	var re *RealmError
	if !errors.As(err, &re) || re.Code != ErrCodeShareSourceReadOnly {
		t.Fatalf("want code %q, got %v", ErrCodeShareSourceReadOnly, err)
	}
	if n := len(f.reqs("/platforms/" + testRealmID + "/signing-keys/split/rotation-lease")); n != 0 {
		t.Errorf("read-only rotation sent %d lease calls", n)
	}
}

// §14.8: clientKey names the limiter bucket.
func TestR9x_HandlerClientKeyChoosesBucket(t *testing.T) {
	f := newFakeIssuer(t)
	f.on("/auth/token", func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		jsonReply(w, 200, map[string]any{"access_token": "AT", "expires_in": 600})
	})
	h := NewIntegrationTokenHandler(f.realm(t, nil), IntegrationHandlerOptions{RatePerMinute: 1,
		ClientKey: func(r *http.Request) string { return r.Header.Get("X-Real-IP") }})
	var codes []int
	for _, ip := range []string{"1.1.1.1", "2.2.2.2", "1.1.1.1"} {
		req := httptest.NewRequest("POST", "/x", bytes.NewReader([]byte(`{"pass":"ip_a"}`)))
		req.RemoteAddr = "198.51.100.7:4000" // same peer for all
		req.Header.Set("X-Real-IP", ip)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		codes = append(codes, rec.Code)
	}
	if codes[0] != 200 || codes[1] != 200 || codes[2] != 429 {
		t.Errorf("codes = %v, want [200 200 429] (buckets keyed by clientKey, not RemoteAddr)", codes)
	}
}
