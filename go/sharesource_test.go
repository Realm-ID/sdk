package realmid

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// SPEC14_5_shares: core sources are env (read-only) and file (atomic, 0600, KEK outside local dev).

func TestShareSource_EnvLoadsBundleAndIsReadOnly(t *testing.T) {
	k := newSplitKey(t, "split-1")
	raw, _ := json.Marshal(k.bundle("r1"))
	t.Setenv("RI_TEST_SHARE_BUNDLE", string(raw))
	src := NewEnvShareSource("RI_TEST_SHARE_BUNDLE")
	if src == nil {
		t.Fatal("NewEnvShareSource returned nil")
	}
	b, ver, err := src.Load(context.Background())
	if err != nil || b == nil || b.Shares["split-1"].DPartner != k.entry().DPartner || ver == "" {
		t.Fatalf("Load: b=%v ver=%q err=%v", b, ver, err)
	}
	if _, ok := src.(WritableShareSource); ok {
		t.Error("env source must be read-only (no Store)")
	}
}

func TestShareSource_EnvUnsetOrMalformedIsAnError(t *testing.T) {
	t.Setenv("RI_TEST_SHARE_BUNDLE", "")
	src := NewEnvShareSource("RI_TEST_SHARE_BUNDLE")
	if src == nil {
		t.Fatal("NewEnvShareSource returned nil")
	}
	if _, _, err := src.Load(context.Background()); err == nil {
		t.Error("unset env: want an error")
	}
	t.Setenv("RI_TEST_SHARE_BUNDLE", "{not json")
	if _, _, err := src.Load(context.Background()); err == nil {
		t.Error("malformed env: want an error")
	}
}

func TestShareSource_FileRoundTripMode0600AtomicAndVersioned(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "shares.json")
	src, err := NewFileShareSource(path, FileShareOptions{LocalDev: true})
	if err != nil {
		t.Fatalf("NewFileShareSource: %v", err)
	}
	k := newSplitKey(t, "split-1")
	v1, err := src.Store(context.Background(), k.bundle("r1"))
	if err != nil {
		t.Fatalf("Store: %v", err)
	}
	b, v1b, err := src.Load(context.Background())
	if err != nil || b.Shares["split-1"].DPartner != k.entry().DPartner || v1b != v1 {
		t.Fatalf("Load after Store: err=%v v=%q/%q", err, v1b, v1)
	}
	st, err := os.Stat(path)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v err=%v, want 0600", st.Mode().Perm(), err)
	}
	k2 := newSplitKey(t, "split-2")
	b2 := k.bundle("r1")
	b2.Shares["split-2"] = k2.entry()
	v2, err := src.Store(context.Background(), b2)
	if err != nil || v2 == v1 {
		t.Errorf("version did not change on write: %q -> %q err=%v", v1, v2, err)
	}
	ents, _ := os.ReadDir(dir)
	if len(ents) != 1 {
		t.Errorf("atomic rename left %d entries in the directory, want 1", len(ents))
	}
}

func TestShareSource_FileRequiresKEKOutsideLocalDev(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shares.json")
	if _, err := NewFileShareSource(path, FileShareOptions{}); err == nil {
		t.Error("no KEK and not LocalDev: want a constructor error")
	}
}

func TestShareSource_FileWithKEKEncryptsAtRestAndWrongKEKFails(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shares.json")
	kek := bytes.Repeat([]byte{7}, 32)
	src, err := NewFileShareSource(path, FileShareOptions{KEK: kek, Realm: "r1"})
	if err != nil {
		t.Fatalf("NewFileShareSource: %v", err)
	}
	k := newSplitKey(t, "split-1")
	if _, err := src.Store(context.Background(), k.bundle("r1")); err != nil {
		t.Fatalf("Store: %v", err)
	}
	raw, _ := os.ReadFile(path)
	if bytes.Contains(raw, []byte(k.entry().DPartner)) {
		t.Error("d_partner is in the file in the clear despite a KEK")
	}
	if b, _, err := src.Load(context.Background()); err != nil || b.Shares["split-1"].DPartner != k.entry().DPartner {
		t.Errorf("Load with the right KEK: %v", err)
	}
	wrong, err := NewFileShareSource(path, FileShareOptions{KEK: bytes.Repeat([]byte{9}, 32), Realm: "r1"})
	if err != nil {
		t.Fatalf("second source: %v", err)
	}
	if _, _, err := wrong.Load(context.Background()); err == nil {
		t.Error("wrong KEK loaded the bundle")
	}
}
