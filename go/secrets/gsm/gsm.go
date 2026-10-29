// Package gsm is the Google Secret Manager share source for split signing (SPEC §14.13, R35).
//
// It is an add-on module so the core stays stdlib-only: this package depends on the core and on
// nothing else. The Secret Manager client is an interface you satisfy with a few lines over
// cloud.google.com/go/secretmanager (AccessSecretVersion on ".../versions/latest" and AddSecretVersion);
// tests use an in-process fake. The secret holds the bundle JSON, or an envelope v1 when a KEK is set.
// A share is never logged or printed.
package gsm

import (
	ctxpkg "context"
	"encoding/json"
	"errors"
	"fmt"

	realmid "github.com/Realm-ID/sdk/go"
)

// Client is the slice of Secret Manager this source uses.
type Client interface {
	// AccessLatest returns the newest enabled version's payload and its version id.
	AccessLatest(ctx ctxpkg.Context, secret string) (data []byte, version string, err error)
	// AddVersion writes a new version and returns its version id.
	AddVersion(ctx ctxpkg.Context, secret string, data []byte) (version string, err error)
}

// Options configures New. KEK (32 bytes) is optional: without it the bundle is stored as plain JSON
// and Secret Manager's own encryption at rest is the only layer; with it the secret is an envelope v1.
type Options struct {
	Client Client
	// Secret is the secret resource name, e.g. projects/p/secrets/realm-shares.
	Secret string
	// Realm is the realm id the envelope is bound to (AAD). Required.
	Realm string
	KEK   []byte
}

type source struct {
	o Options
}

// New returns a writable share source over one Secret Manager secret.
func New(o Options) (realmid.WritableShareSource, error) {
	switch {
	case o.Client == nil:
		return nil, errors.New("gsm: Options.Client is required")
	case o.Secret == "":
		return nil, errors.New("gsm: Options.Secret is required")
	case o.Realm == "":
		return nil, errors.New("gsm: Options.Realm is required (the envelope is bound to the realm)")
	case len(o.KEK) != 0 && len(o.KEK) != 32:
		return nil, errors.New("gsm: the KEK must be 32 bytes")
	}
	o.KEK = append([]byte(nil), o.KEK...)
	return &source{o: o}, nil
}

// Load reads the latest version. The version returned is Secret Manager's own version id.
func (s *source) Load(ctx ctxpkg.Context) (*realmid.ShareBundle, string, error) {
	raw, ver, err := s.o.Client.AccessLatest(ctx, s.o.Secret)
	if err != nil {
		return nil, "", fmt.Errorf("gsm: read share secret: %w", err)
	}
	plain := raw
	if len(s.o.KEK) > 0 {
		if plain, err = open(s.o.KEK, s.o.Realm, raw); err != nil {
			return nil, "", err
		}
	}
	if len(s.o.KEK) == 0 {
		// An envelope read without a KEK would parse as an EMPTY bundle (unknown fields are
		// ignored), so a missing KEK would look like "no shares" instead of failing.
		var probe struct {
			V   int    `json:"v"`
			Alg string `json:"alg"`
		}
		if json.Unmarshal(plain, &probe) == nil && probe.V == 1 && probe.Alg != "" {
			return nil, "", errors.New("gsm: the secret is an encrypted envelope but no KEK is configured")
		}
	}
	var b realmid.ShareBundle
	if json.Unmarshal(plain, &b) != nil {
		// json errors can echo input bytes; say nothing about them.
		return nil, "", errors.New("gsm: share secret is not a valid bundle")
	}
	if b.Shares == nil {
		b.Shares = map[string]realmid.ShareEntry{}
	}
	return &b, ver, nil
}

// Store writes the bundle as a new secret version and returns that version id.
func (s *source) Store(ctx ctxpkg.Context, b *realmid.ShareBundle) (string, error) {
	plain, err := json.Marshal(b)
	if err != nil {
		return "", fmt.Errorf("gsm: encode share bundle: %w", err)
	}
	out := plain
	if len(s.o.KEK) > 0 {
		if out, err = seal(s.o.KEK, s.o.Realm, plain); err != nil {
			return "", fmt.Errorf("gsm: seal share bundle: %w", err)
		}
	}
	ver, err := s.o.Client.AddVersion(ctx, s.o.Secret, out)
	if err != nil {
		return "", fmt.Errorf("gsm: write share secret: %w", err)
	}
	return ver, nil
}
