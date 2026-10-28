package realmid

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"
)

// SPEC14_4_trust: a split verifier trusts the bundle's public keys only, never RI's JWKS.

func TestTrust_SplitRealmWithoutShareSourceFailsToConstruct(t *testing.T) {
	f := newFakeIssuer(t)
	_, err := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: f.srv.URL, Split: true})
	if err == nil {
		t.Fatal("NewRealm(Split:true) with no ShareSource succeeded; want a construction error")
	}
}

func TestTrust_BundleKeyAcceptedAndRIJWKSNeverFetched(t *testing.T) {
	k := newSplitKey(t, "split-1")
	f := newFakeIssuer(t)
	f.on("/"+testRealmID+"/.well-known/jwks.json", func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
		jsonReply(w, 200, map[string]any{"keys": []any{}})
	})
	r := f.realm(t, func(c *Config) { c.Split = true; c.ShareSource = &memShares{b: k.bundle(testRealmID)} })
	if _, err := r.Verify(context.Background(), k.fullJWT(t, userClaims(issuerOf(f))), nil); err != nil {
		t.Fatalf("token under a pinned bundle key refused: %v", err)
	}
	if n := len(f.reqs("/" + testRealmID + "/.well-known/jwks.json")); n != 0 {
		t.Errorf("split verifier fetched RI's JWKS %d times; want 0", n)
	}
}

func TestTrust_RIPublishedKIDRefusedAsUnpinned(t *testing.T) {
	bundleKey := newSplitKey(t, "split-1")
	riKey := newSplitKey(t, "ri-full-1") // a key RI publishes in its JWKS, not in the bundle
	f := newFakeIssuer(t)
	f.on("/"+testRealmID+"/.well-known/jwks.json", func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
		jsonReply(w, 200, map[string]any{"keys": []any{map[string]any{"kty": "RSA", "kid": "ri-full-1", "alg": "RS256", "use": "sig",
			"n": b64big(riKey.priv.N), "e": "AQAB"}}})
	})
	r := f.realm(t, func(c *Config) { c.Split = true; c.ShareSource = &memShares{b: bundleKey.bundle(testRealmID)} })
	_, err := r.Verify(context.Background(), riKey.fullJWT(t, userClaims(issuerOf(f))), nil)
	var re *RealmError
	if !errors.As(err, &re) || re.Code != ErrCodeUnpinnedKID {
		t.Fatalf("RI-published kid: want RealmError code %q, got %v", ErrCodeUnpinnedKID, err)
	}
}

func TestTrust_PreviousKeyTrustedUntilTrustUntil(t *testing.T) {
	cur := newSplitKey(t, "split-2")
	old := newSplitKey(t, "split-1")
	f := newFakeIssuer(t)
	now := time.Now()
	b := cur.bundle(testRealmID)
	b.Previous = []PreviousKey{{KID: "split-1", N: b64big(old.priv.N), E: "AQAB", TrustUntil: now.Add(time.Hour).Unix()}}
	clock := now
	r := f.realm(t, func(c *Config) {
		c.Split = true
		c.ShareSource = &memShares{b: b}
		c.Clock = func() time.Time { return clock }
	})
	tok := old.fullJWT(t, userClaims(issuerOf(f)))
	if _, err := r.Verify(context.Background(), tok, nil); err != nil {
		t.Fatalf("previous key inside trust_until refused: %v", err)
	}
	clock = now.Add(2 * time.Hour)
	tok = old.fullJWT(t, func() map[string]any {
		c := userClaims(issuerOf(f))
		c["iat"], c["exp"] = clock.Unix(), clock.Add(10*time.Minute).Unix()
		return c
	}())
	_, err := r.Verify(context.Background(), tok, nil)
	var re *RealmError
	if !errors.As(err, &re) || re.Code != ErrCodeUnpinnedKID {
		t.Fatalf("previous key past trust_until: want %q, got %v", ErrCodeUnpinnedKID, err)
	}
}
