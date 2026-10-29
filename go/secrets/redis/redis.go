// Package redis is the Redis + KEK share source for split signing (SPEC §14.13, R35, R39).
//
// It is an add-on module so the core stays stdlib-only: this package depends on the core and on
// nothing else. The Redis client is an interface you satisfy with a few lines over go-redis (or any
// client); tests use an in-process fake. Keys: realmid:share:<realm>:bundle (envelope v1, with
// `ver`), :public (the public halves only, plain JSON) and :version (the current version string,
// also published on the channel of the same name so pods re-read at once; pods also poll). Redis
// MUST persist (R39(2)): New refuses an instance that does not. A share is never logged or printed.
package redis

import (
	ctxpkg "context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	realmid "github.com/Realm-ID/sdk/go"
)

// Client is the slice of Redis this source uses.
type Client interface {
	// Get returns the string at key; found is false for an absent key.
	Get(ctx ctxpkg.Context, key string) (value string, found bool, err error)
	Set(ctx ctxpkg.Context, key, value string) error
	Publish(ctx ctxpkg.Context, channel, message string) error
	// Persistent reports whether the server persists writes (AOF or RDB configured).
	Persistent(ctx ctxpkg.Context) (bool, error)
}

// Options configures New. KEKs are 32-byte keys; the FIRST seals every write, any listed key opens
// (so a KEK rotation lists the new key first and the retired one after it).
type Options struct {
	Client Client
	Realm  string
	KEKs   [][]byte
}

type source struct {
	o Options
}

// New returns a writable share source, refusing a Redis with no persistence.
func New(ctx ctxpkg.Context, o Options) (realmid.WritableShareSource, error) {
	switch {
	case o.Client == nil:
		return nil, errors.New("redis: Options.Client is required")
	case o.Realm == "":
		return nil, errors.New("redis: Options.Realm is required (the envelope is bound to the realm)")
	case len(o.KEKs) == 0:
		return nil, errors.New("redis: at least one KEK is required (shares are never stored in plaintext)")
	}
	keks := make([][]byte, len(o.KEKs))
	for i, k := range o.KEKs {
		if len(k) != 32 {
			return nil, fmt.Errorf("redis: KEK %d must be 32 bytes", i+1)
		}
		keks[i] = append([]byte(nil), k...)
	}
	o.KEKs = keks
	ok, err := o.Client.Persistent(ctx)
	if err != nil {
		return nil, fmt.Errorf("redis: check persistence: %w", err)
	}
	if !ok {
		return nil, errors.New("redis: the server has no persistence; a share lost on restart is a lost signing half (enable AOF or RDB)")
	}
	return &source{o: o}, nil
}

// ParseKEKList parses REALM_ID_SHARE_KEK: `<b64url 32 bytes>[,<b64url 32 bytes>…]`, the first the
// write key. Any malformed or short entry fails the whole list.
func ParseKEKList(s string) ([][]byte, error) {
	if strings.TrimSpace(s) == "" {
		return nil, errors.New("redis: KEK list is empty")
	}
	var out [][]byte
	for i, part := range strings.Split(s, ",") {
		k, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(strings.TrimSpace(part), "="))
		if err != nil || len(k) != 32 {
			return nil, fmt.Errorf("redis: KEK %d is not base64url of 32 bytes", i+1)
		}
		out = append(out, k)
	}
	return out, nil
}

func (s *source) key(part string) string { return "realmid:share:" + s.o.Realm + ":" + part }

func (s *source) Load(ctx ctxpkg.Context) (*realmid.ShareBundle, string, error) {
	raw, found, err := s.o.Client.Get(ctx, s.key("bundle"))
	if err != nil {
		return nil, "", fmt.Errorf("redis: read share bundle: %w", err)
	}
	if !found {
		return nil, "", fmt.Errorf("redis: no share bundle at %s", s.key("bundle"))
	}
	plain, ver, err := open(s.o.KEKs, s.o.Realm, []byte(raw))
	if err != nil {
		return nil, "", err
	}
	var b realmid.ShareBundle
	if json.Unmarshal(plain, &b) != nil {
		return nil, "", errors.New("redis: share bundle is not valid JSON")
	}
	if b.Shares == nil {
		b.Shares = map[string]realmid.ShareEntry{}
	}
	return &b, ver, nil
}

type publicKey struct {
	KID string `json:"kid"`
	N   string `json:"n"`
	E   string `json:"e"`
}

// Store seals the bundle under the first KEK with a fresh version, then writes :public, then the
// :version key LAST and publishes it, so a watcher that sees a new version finds the new bundle.
func (s *source) Store(ctx ctxpkg.Context, b *realmid.ShareBundle) (string, error) {
	plain, err := json.Marshal(b)
	if err != nil {
		return "", fmt.Errorf("redis: encode share bundle: %w", err)
	}
	vb := make([]byte, 8)
	if _, err := rand.Read(vb); err != nil {
		return "", fmt.Errorf("redis: new version: %w", err)
	}
	ver := hex.EncodeToString(vb)
	env, err := seal(s.o.KEKs[0], s.o.Realm, ver, plain)
	if err != nil {
		return "", fmt.Errorf("redis: seal share bundle: %w", err)
	}
	keys := make([]publicKey, 0, len(b.Shares))
	for kid, e := range b.Shares {
		keys = append(keys, publicKey{KID: kid, N: e.N, E: e.E})
	}
	pub, _ := json.Marshal(struct {
		Realm    string                `json:"realm"`
		Keys     []publicKey           `json:"keys"`
		Previous []realmid.PreviousKey `json:"previous,omitempty"`
	}{b.Realm, keys, b.Previous})
	for _, w := range []struct{ k, v string }{
		{s.key("bundle"), string(env)}, {s.key("public"), string(pub)}, {s.key("version"), ver},
	} {
		if err := s.o.Client.Set(ctx, w.k, w.v); err != nil {
			return "", fmt.Errorf("redis: write %s: %w", w.k, err)
		}
	}
	if err := s.o.Client.Publish(ctx, s.key("version"), ver); err != nil {
		// The write is durable and pods poll; a lost notification only delays them.
		return ver, fmt.Errorf("redis: bundle written as version %s but the publish failed: %w", ver, err)
	}
	return ver, nil
}
