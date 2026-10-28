package realmid

// Share custody for a split-signing realm (SPEC §14.5): the partner's half of each private
// exponent (d_partner) plus the public keys the verifier pins. Core sources are stdlib only:
// environment (read-only) and file (atomic rename, mode 0600, KEK required outside local dev).
// GSM and Redis+KEK are add-ons in sdk/go/secrets. A share is never logged or printed.

import (
	ctxpkg "context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// ShareEntry is one split key's partner half. N, E, DPartner are base64url big-endian integers
// (the wire encoding of the upload route) [inferred]. Every fmt verb prints DPartner redacted.
type ShareEntry struct {
	N        string `json:"n"`
	E        string `json:"e"`
	DPartner string `json:"d_partner"`
}

// Format redacts DPartner under every fmt verb (%v, %+v, %#v, %s), so a share logged by accident
// prints a placeholder. JSON encoding (the custody store's own) is unaffected.
func (e ShareEntry) Format(f fmt.State, _ rune) {
	_, _ = fmt.Fprintf(f, "ShareEntry{N:%s E:%s DPartner:[redacted]}", e.N, e.E)
}

// PreviousKey is a retired split key still trusted until TrustUntil (unix seconds) [inferred].
type PreviousKey struct {
	KID        string `json:"kid"`
	N          string `json:"n"`
	E          string `json:"e"`
	TrustUntil int64  `json:"trust_until"`
}

// ShareBundle is the partner's custody document (v2 § 3.7, shape inferred).
type ShareBundle struct {
	Realm    string                `json:"realm"`
	Shares   map[string]ShareEntry `json:"shares"`
	Previous []PreviousKey         `json:"previous,omitempty"`
}

// ShareSource loads the bundle and an opaque version string that changes on every write.
type ShareSource interface {
	Load(ctx ctxpkg.Context) (*ShareBundle, string, error)
}

// WritableShareSource is a ShareSource that can persist a new bundle (file; not env).
type WritableShareSource interface {
	ShareSource
	Store(ctx ctxpkg.Context, b *ShareBundle) (string, error)
}

func shareVersion(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:8])
}

func parseBundle(raw []byte) (*ShareBundle, error) {
	var b ShareBundle
	if err := json.Unmarshal(raw, &b); err != nil {
		// The error text of json can echo input bytes; say nothing about them.
		return nil, errors.New("realmid: share bundle is not valid JSON")
	}
	if b.Shares == nil {
		b.Shares = map[string]ShareEntry{}
	}
	return &b, nil
}

type envShareSource struct{ name string }

// NewEnvShareSource reads the bundle JSON from the named environment variable. It is read-only:
// it has no Store, so rotation and recovery on it go through the CLI.
func NewEnvShareSource(envVar string) ShareSource { return &envShareSource{name: envVar} }

func (s *envShareSource) Load(ctxpkg.Context) (*ShareBundle, string, error) {
	raw := os.Getenv(s.name)
	if raw == "" {
		return nil, "", fmt.Errorf("realmid: share bundle environment variable %s is not set", s.name)
	}
	b, err := parseBundle([]byte(raw))
	if err != nil {
		return nil, "", err
	}
	return b, shareVersion([]byte(raw)), nil
}

// FileShareOptions configures NewFileShareSource. KEK is the 32-byte key-encryption key;
// LocalDev permits a plaintext file (no KEK) and nothing else does [inferred].
type FileShareOptions struct {
	KEK      []byte
	LocalDev bool
	// Realm is the realm id the envelope is bound to (AAD, SPEC §14.5). Required with a KEK.
	Realm string
}

type fileShareSource struct {
	path string
	gcm  cipher.AEAD // nil = plaintext (local dev)
	kid  string      // KEK id
	aad  []byte      // realmid-share/v1|<realm>|<kek id>
	mu   sync.Mutex
}

// fileEnvelope is envelope v1 (SPEC §14.5): the at-rest shape when a KEK is set. Ver is set only
// by sources that carry their own version (Redis); this file store leaves it out.
type fileEnvelope struct {
	V     int    `json:"v"`
	Alg   string `json:"alg"`
	KEKID string `json:"kek_id"`
	Nonce string `json:"nonce"`
	CT    string `json:"ct"`
	Ver   string `json:"ver,omitempty"`
}

// kekID is the first 16 hex of sha256("realmid-kek-id/v1" || kek): derived, so every SDK and the
// CLI compute the same id with no naming step.
func kekID(kek []byte) string {
	sum := sha256.Sum256(append([]byte("realmid-kek-id/v1"), kek...))
	return hex.EncodeToString(sum[:])[:16]
}

// NewFileShareSource is the atomic-rename, mode-0600 file store. A KEK (32 bytes) encrypts the
// bundle with AES-256-GCM; without one the constructor refuses unless opts.LocalDev is set.
func NewFileShareSource(path string, opts FileShareOptions) (WritableShareSource, error) {
	s := &fileShareSource{path: path}
	switch {
	case len(opts.KEK) > 0:
		if len(opts.KEK) != 32 {
			return nil, errors.New("realmid: the share-file KEK must be 32 bytes")
		}
		blk, err := aes.NewCipher(opts.KEK)
		if err != nil {
			return nil, err
		}
		if s.gcm, err = cipher.NewGCM(blk); err != nil {
			return nil, err
		}
		if opts.Realm == "" {
			return nil, errors.New("realmid: a share file with a KEK needs FileShareOptions.Realm (the envelope is bound to the realm)")
		}
		s.kid = kekID(opts.KEK)
		s.aad = []byte("realmid-share/v1|" + opts.Realm + "|" + s.kid)
	case opts.LocalDev:
	default:
		return nil, errors.New("realmid: a share file needs a KEK outside local development (FileShareOptions.KEK)")
	}
	return s, nil
}

func (s *fileShareSource) Load(ctxpkg.Context) (*ShareBundle, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return nil, "", fmt.Errorf("realmid: read share file: %w", err)
	}
	plain := raw
	if s.gcm != nil {
		var env fileEnvelope
		if json.Unmarshal(raw, &env) != nil || env.V != 1 || env.Alg != "A256GCM" {
			return nil, "", errors.New("realmid: share file is not an encrypted bundle")
		}
		if env.KEKID != s.kid {
			return nil, "", fmt.Errorf("realmid: share file is sealed under KEK %q, not the configured %q", env.KEKID, s.kid)
		}
		nonce, err1 := base64.RawURLEncoding.DecodeString(env.Nonce)
		ct, err2 := base64.RawURLEncoding.DecodeString(env.CT)
		if err1 != nil || err2 != nil || len(nonce) != s.gcm.NonceSize() {
			return nil, "", errors.New("realmid: share file envelope is malformed")
		}
		if plain, err = s.gcm.Open(nil, nonce, ct, s.aad); err != nil {
			return nil, "", errors.New("realmid: share file did not decrypt (wrong KEK or realm?)")
		}
	}
	b, err := parseBundle(plain)
	if err != nil {
		return nil, "", err
	}
	return b, shareVersion(raw), nil
}

func (s *fileShareSource) Store(_ ctxpkg.Context, b *ShareBundle) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	plain, err := json.Marshal(b)
	if err != nil {
		return "", err
	}
	out := plain
	if s.gcm != nil {
		nonce := make([]byte, s.gcm.NonceSize())
		if _, err := rand.Read(nonce); err != nil {
			return "", err
		}
		out, _ = json.Marshal(fileEnvelope{V: 1, Alg: "A256GCM", KEKID: s.kid,
			Nonce: base64.RawURLEncoding.EncodeToString(nonce),
			CT:    base64.RawURLEncoding.EncodeToString(s.gcm.Seal(nil, nonce, plain, s.aad))})
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".shares-*")
	if err != nil {
		return "", fmt.Errorf("realmid: write share file: %w", err)
	}
	cleanup := func() { _ = tmp.Close(); _ = os.Remove(tmp.Name()) }
	if err := tmp.Chmod(0o600); err != nil {
		cleanup()
		return "", err
	}
	if _, err := tmp.Write(out); err != nil {
		cleanup()
		return "", err
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmp.Name())
		return "", err
	}
	if err := os.Rename(tmp.Name(), s.path); err != nil {
		_ = os.Remove(tmp.Name())
		return "", fmt.Errorf("realmid: write share file: %w", err)
	}
	return shareVersion(out), nil
}
