package realmid

// Partner-side split-key rotation and lost-half recovery (SPEC §14.5, §14.12; R63, R67.3, R72).
// Every call here carries the platform token and NO actor: rotation routes are no-actor (R67.3).
// The wire shape of the handshake challenge ({nonce, partial_ri}) and answer ({sig}) is
// [inferred]: swagger says only "returns a challenge" and "Body {sig}".

import (
	ctxpkg "context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"net/url"
	"time"
)

// RotateSplitOptions drives SigningKeysClient.RotateSplit. Recovery=true keeps no previous key.
type RotateSplitOptions struct {
	KID      string
	Recovery bool
	// PreviousTrust is how long the retired key stays trusted after a normal rotation
	// (default splitPreviousTrust). Ignored for Recovery.
	PreviousTrust time.Duration
}

// splitPreviousTrust is the default trust_until window for the key a normal rotation retires: a
// day, the overlap default of the custody swagger, which outlives any access token (<= 15 min).
const splitPreviousTrust = 24 * time.Hour

var errRotateReadOnly = errors.New("realmid: this share source is read-only; rotate with the CLI, then reload the bundle")

// RotateSplit runs lease → keygen → store → upload d_ri → handshake → complete on a WRITABLE
// share source. The new share is stored BEFORE the upload so a crash never strands a key whose
// other half RealmID already holds. A failed handshake stops with an error and is never retried
// here (an unattended loop would burn the emergency-rotation cap). After the handshake succeeds
// the bundle is compacted: the new share is the only current one and, unless Recovery is set,
// the retired key stays trusted until trust_until. A read-only source (environment) cannot
// rotate and sends nothing.
func (c *SigningKeysClient) RotateSplit(ctx ctxpkg.Context, store ShareSource, opts RotateSplitOptions) error {
	w, ok := store.(WritableShareSource)
	if !ok {
		return errRotateReadOnly
	}
	if opts.KID == "" {
		return &RealmError{Code: ErrCodeBadRequest, Message: "RotateSplit needs a KID"}
	}
	r := c.realm
	ctx = WithUserToken(ctx, "") // no actor on any rotation call (R67.3)
	cur, _, err := w.Load(ctx)
	if err != nil {
		return err
	}
	tok, err := r.platformToken.get(ctx)
	if err != nil {
		return err
	}
	base := "/platforms/" + url.PathEscape(r.realmID) + "/signing-keys/split"
	if err := r.http.do(ctx, requestOptions{Method: "POST", Path: base + "/rotation-lease", Bearer: tok}, nil); err != nil {
		return err
	}

	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return fmt.Errorf("realmid: generate split key: %w", err)
	}
	dRI, dP, err := splitExponent(priv)
	if err != nil {
		return err
	}
	entry := ShareEntry{N: bigB64(priv.N), E: bigB64(big.NewInt(int64(priv.E))), DPartner: bigB64(dP)}
	next := cloneBundle(cur)
	if next.Realm == "" {
		next.Realm = r.realmID
	}
	next.Shares[opts.KID] = entry
	if _, err := w.Store(ctx, next); err != nil {
		return fmt.Errorf("realmid: store the new share: %w", err)
	}

	if err := r.http.do(ctx, requestOptions{Method: "POST", Path: base, Bearer: tok, Body: map[string]any{
		"kid": opts.KID, "n": entry.N, "e": entry.E, "d_ri": bigB64(dRI),
	}}, nil); err != nil {
		return err
	}
	kidPath := base + "/" + url.PathEscape(opts.KID)
	var ch struct {
		Nonce     string `json:"nonce"`
		PartialRI string `json:"partial_ri"`
	}
	if err := r.http.do(ctx, requestOptions{Method: "POST", Path: kidPath + "/handshake", Bearer: tok}, &ch); err != nil {
		return err
	}
	ri, err := base64.RawURLEncoding.DecodeString(ch.PartialRI)
	if err != nil {
		return &RealmError{Code: ErrCodeServerError, Message: "handshake partial_ri is not base64url", Cause: err}
	}
	sig, err := CompleteHandshake(entry, r.realmID, opts.KID, ch.Nonce, ri)
	if err != nil {
		return fmt.Errorf("realmid: handshake: %w", err)
	}
	if err := r.http.do(ctx, requestOptions{Method: "POST", Path: kidPath + "/handshake/complete", Bearer: tok,
		Body: map[string]any{"sig": base64.RawURLEncoding.EncodeToString(sig)}}, nil); err != nil {
		return err
	}

	// Handshake done: the new key is the one current share.
	final := &ShareBundle{Realm: next.Realm, Shares: map[string]ShareEntry{opts.KID: entry}}
	if !opts.Recovery {
		trust := opts.PreviousTrust
		if trust <= 0 {
			trust = splitPreviousTrust
		}
		until := r.clock().Add(trust).Unix()
		final.Previous = append(final.Previous, cur.Previous...)
		for kid, e := range cur.Shares {
			if kid != opts.KID {
				final.Previous = append(final.Previous, PreviousKey{KID: kid, N: e.N, E: e.E, TrustUntil: until})
			}
		}
	}
	if _, err := w.Store(ctx, final); err != nil {
		return fmt.Errorf("realmid: the new key is active at RealmID but the bundle could not be compacted: %w", err)
	}
	return nil
}

// splitExponent splits priv's private exponent d = d_ri + d_partner (mod lambda(n)).
func splitExponent(priv *rsa.PrivateKey) (dRI, dP *big.Int, err error) {
	if len(priv.Primes) != 2 {
		return nil, nil, errors.New("realmid: unexpected RSA key shape")
	}
	one := big.NewInt(1)
	p1 := new(big.Int).Sub(priv.Primes[0], one)
	q1 := new(big.Int).Sub(priv.Primes[1], one)
	lam := new(big.Int).Div(new(big.Int).Mul(p1, q1), new(big.Int).GCD(nil, nil, p1, q1))
	d := new(big.Int).Mod(priv.D, lam)
	if dRI, err = rand.Int(rand.Reader, lam); err != nil {
		return nil, nil, err
	}
	dP = new(big.Int).Mod(new(big.Int).Sub(d, dRI), lam)
	return dRI, dP, nil
}

func bigB64(i *big.Int) string { return base64.RawURLEncoding.EncodeToString(i.Bytes()) }

func cloneBundle(b *ShareBundle) *ShareBundle {
	out := &ShareBundle{Realm: b.Realm, Shares: make(map[string]ShareEntry, len(b.Shares)+1)}
	for k, v := range b.Shares {
		out.Shares[k] = v
	}
	out.Previous = append(out.Previous, b.Previous...)
	return out
}
