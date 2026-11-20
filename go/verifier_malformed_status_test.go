package realmid

// SPEC §3.1 — every `malformed` verifier error carries httpStatus 401, whatever the cause.

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"testing"
)

func TestVerifyMalformedAlwaysCarries401(t *testing.T) {
	e := newV063Env(t, nil)
	b := func(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
	okHdr := `{"alg":"RS256","typ":"JWT","kid":"k1"}`
	okPay := `{"iss":"` + e.srv.URL + `/` + testRealmID + `","sub":"u1"}`
	cases := map[string]string{
		"two parts":      "a.b",
		"header b64":     "!!!." + b(okPay) + "." + b("s"),
		"header json":    b("{") + "." + b(okPay) + "." + b("s"),
		"kid missing":    b(`{"alg":"RS256","typ":"JWT"}`) + "." + b(okPay) + "." + b("s"),
		"header null":    b("null") + "." + b(okPay) + "." + b("s"),
		"header array":   b("[]") + "." + b(okPay) + "." + b("s"),
		"header string":  b(`"x"`) + "." + b(okPay) + "." + b("s"),
		"header number":  b("1") + "." + b(okPay) + "." + b("s"),
		"payload b64":    b(okHdr) + ".!!!." + b("s"),
		"sig b64":        b(okHdr) + "." + b(okPay) + ".!!!",
		"payload json":   b(okHdr) + "." + b("{") + "." + b("s"),
		"claim fold":     b(okHdr) + "." + b(`{"iss":"x","Sub":"u1","sub":"u1"}`) + "." + b("s"),
		"claims json":    b(okHdr) + "." + b(`{"iss":"x","exp":"soon"}`) + "." + b("s"),
		"iss missing":    b(okHdr) + "." + b(`{"sub":"u1"}`) + "." + b("s"),
		"typ not access": b(`{"alg":"RS256","typ":"refresh+jwt","kid":"k1"}`) + "." + b(okPay) + "." + b("s"),
		"events claim":   e.tok(nil, func(c map[string]any) { c["events"] = map[string]any{} }),
		"blank sub":      e.tok(nil, func(c map[string]any) { c["sub"] = "" }),
	}
	for name, tok := range cases {
		_, err := e.realm.Verify(context.Background(), tok, nil)
		var re *RealmError
		if !errors.As(err, &re) || re.Code != ErrCodeMalformed {
			t.Errorf("%s: want malformed, got %v", name, err)
			continue
		}
		if re.HTTPStatus != http.StatusUnauthorized {
			t.Errorf("%s: HTTPStatus = %d, want 401", name, re.HTTPStatus)
		}
	}
}
