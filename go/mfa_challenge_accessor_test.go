package realmid

// SPEC §3.2: RealmError.MFAChallenge reads the step-up challenge a 412 carries, so a caller of the
// public MintMFAChallenge never digs through Details by hand.

import (
	"context"
	"errors"
	"net/http"
	"testing"
)

func TestRealmErrorMFAChallenge_FromDetails(t *testing.T) {
	e := &RealmError{Code: ErrCodeMFARegistrationRequired, HTTPStatus: 412, Details: map[string]any{
		"mfa_challenge_token": "enroll-tok-1",
		"methods":             []any{"totp", 7, "otp"},
	}}
	tok, methods := e.MFAChallenge()
	if tok != "enroll-tok-1" {
		t.Errorf("token %q", tok)
	}
	if len(methods) != 2 || methods[0] != "totp" || methods[1] != "otp" {
		t.Errorf("methods %v, want [totp otp] (non-strings skipped)", methods)
	}
}

func TestRealmErrorMFAChallenge_MissingAndNil(t *testing.T) {
	for name, e := range map[string]*RealmError{
		"nil receiver":      nil,
		"nil details":       {Code: ErrCodeMFARequired, HTTPStatus: 412},
		"wrong types":       {Details: map[string]any{"mfa_challenge_token": 5, "methods": "totp"}},
		"service principal": {Code: ErrCodeMFARequired, HTTPStatus: 412, Details: map[string]any{}},
	} {
		tok, methods := e.MFAChallenge()
		if tok != "" || len(methods) != 0 {
			t.Errorf("%s: got %q %v, want empty", name, tok, methods)
		}
	}
}

func TestMintMFAChallenge_412CarriesTokenViaAccessor(t *testing.T) {
	_, pub := mintTestKey(t, "kid-1")
	srv := mwTestServer(t, []jwk{pub}, testAud, map[string]http.HandlerFunc{"/auth/mfa/challenge": mfaEnrollIssuer})
	defer srv.Close()
	r, _ := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	_, _, err := r.Auth.MintMFAChallenge(WithUserToken(context.Background(), "user-jwt"), MFAChallengeRequest{})
	var re *RealmError
	if !errors.As(err, &re) {
		t.Fatalf("err %v, want *RealmError", err)
	}
	tok, methods := re.MFAChallenge()
	if tok != "enroll-tok-1" || len(methods) != 1 || methods[0] != "totp" {
		t.Errorf("accessor gave %q %v, want enroll-tok-1 [totp]", tok, methods)
	}
}
