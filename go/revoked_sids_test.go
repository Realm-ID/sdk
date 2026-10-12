package realmid

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"
)

// ADR-104 § Owner rulings R-e (go 0.65.0): the three whole-identity revokes
// return `revoked_sids`, and the SDK writes each into the SessionStore exactly
// as Logout does.

type revokeFailStore struct{ *MemorySessionStore }

func (revokeFailStore) RevokeSession(context.Context, string, time.Time) error {
	return errors.New("store down")
}

type rsidEnv struct {
	r    *Realm
	sign func(map[string]any) string
	srv  string
}

// newRSIDEnv serves /auth/login (password grant) and /auth/password/reset, both
// answering with `extra` merged in.
func newRSIDEnv(t *testing.T, store SessionStateStore, extra map[string]any) *rsidEnv {
	t.Helper()
	sign, key := mintTestKey(t, "k1")
	e := &rsidEnv{sign: sign}
	reply := func(base map[string]any) http.HandlerFunc {
		return func(w http.ResponseWriter, _ *http.Request) {
			for k, v := range extra {
				base[k] = v
			}
			_ = json.NewEncoder(w).Encode(base)
		}
	}
	srv := mwTestServer(t, []jwk{key}, testAud, map[string]http.HandlerFunc{
		"/auth/login":          reply(map[string]any{"access_token": "a", "refresh_token": "r", "user": map[string]any{"id": "u"}}),
		"/auth/password/reset": reply(map[string]any{"status": "password_set"}),
	})
	t.Cleanup(srv.Close)
	e.srv = srv.URL
	r, err := NewRealm(Config{SessionStore: store, RealmID: testRealmID, APIKey: "k", BaseURL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	e.r = r
	return e
}

func (e *rsidEnv) tok(sid string) string {
	return e.sign(baseClaims(e.srv, func(c map[string]any) { c["sid"] = sid }))
}

func (e *rsidEnv) revoked(sid string) bool {
	return e.r.Tokens.GateRequest(context.Background(), e.tok(sid)) != nil
}

type rsidCall struct {
	name string
	do   func(e *rsidEnv) ([]string, error)
}

var rsidCalls = []rsidCall{
	{"password_login_change_at_sign_in", func(e *rsidEnv) ([]string, error) {
		s, err := e.r.Auth.PasswordLogin(context.Background(), PasswordLoginRequest{Identifier: "a@b.c", Presented: "old", NewPassword: "brand-new-pass-1"})
		if err != nil {
			return nil, err
		}
		return s.RevokedSIDs, nil
	}},
	{"consume_password_reset", func(e *rsidEnv) ([]string, error) {
		out, err := e.r.Auth.ConsumePasswordReset(context.Background(), "tok", "a-long-new-password")
		if err != nil {
			return nil, err
		}
		return out.RevokedSIDs, nil
	}},
}

func TestRevokedSIDs_WrittenToStoreAndTokenRefused(t *testing.T) {
	for _, c := range rsidCalls {
		t.Run(c.name, func(t *testing.T) {
			e := newRSIDEnv(t, NewMemorySessionStore(), map[string]any{"revoked_sids": []string{"s1", "s2"}})
			if e.revoked("s1") || e.revoked("s2") {
				t.Fatal("precondition: tokens must pass before the call")
			}
			got, err := c.do(e)
			if err != nil {
				t.Fatal(err)
			}
			if len(got) != 2 || got[0] != "s1" || got[1] != "s2" {
				t.Errorf("RevokedSIDs = %v", got)
			}
			if !e.revoked("s1") || !e.revoked("s2") {
				t.Error("a token carrying a listed sid must be refused after the call")
			}
			if e.revoked("s3") {
				t.Error("an unlisted sid must keep passing")
			}
		})
	}
}

func TestRevokedSIDs_EmptyOrAbsentWritesNothing(t *testing.T) {
	for _, c := range rsidCalls {
		for name, extra := range map[string]map[string]any{
			"empty":     {"revoked_sids": []string{}},
			"absent":    {},
			"malformed": {"revoked_sids": "s1"},
		} {
			t.Run(c.name+"/"+name, func(t *testing.T) {
				e := newRSIDEnv(t, NewMemorySessionStore(), extra)
				got, err := c.do(e)
				if err != nil {
					t.Fatalf("an older issuer omits the field; not an error: %v", err)
				}
				if len(got) != 0 {
					t.Errorf("RevokedSIDs = %v, want none", got)
				}
				if e.revoked("s1") {
					t.Error("nothing listed, nothing written")
				}
			})
		}
	}
}

// Logout logs a store write error and never returns it; the new calls mirror it.
func TestRevokedSIDs_StoreWriteErrorIsNotReturned(t *testing.T) {
	for _, c := range rsidCalls {
		t.Run(c.name, func(t *testing.T) {
			e := newRSIDEnv(t, revokeFailStore{NewMemorySessionStore()}, map[string]any{"revoked_sids": []string{"s1"}})
			got, err := c.do(e)
			if err != nil {
				t.Fatalf("store failure must not fail the call (Logout parity): %v", err)
			}
			if len(got) != 1 || got[0] != "s1" {
				t.Errorf("RevokedSIDs = %v", got)
			}
		})
	}
}
