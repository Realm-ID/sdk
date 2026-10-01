package realmid

import (
	"context"
	"testing"
)

// M1 (final critic, dispatcher decision): verify() consults Config.Revocation
// under the session key AND, when the jti differs, under the jti — so a
// partner's own Revoke(claims.JWTID, …) stays effective once sid != jti.
func TestSPEC6_7_6_VerifyChecksSessionKeyAndJTI(t *testing.T) {
	for name, tc := range map[string]struct {
		revoke  string
		refused bool
	}{
		"session key": {"S1", true},
		"jti":         {"J1", true},
		"neither":     {"other", false},
	} {
		t.Run(name, func(t *testing.T) {
			e := newMWEnv(t)
			rev := &recRevocation{}
			e.realm.revocation = rev
			_ = rev.Revoke(context.Background(), tc.revoke, e.realm.Tokens.until())
			tok := e.sign(baseClaims(e.srv.URL, func(c map[string]any) { c["sid"] = "S1"; c["jti"] = "J1" }))
			_, err := e.realm.Verify(context.Background(), tok, nil)
			if (err != nil) != tc.refused {
				t.Fatalf("revoked=%q: refused=%v, want %v (err %v)", tc.revoke, err != nil, tc.refused, err)
			}
		})
	}
}
