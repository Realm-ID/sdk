package realmid

import (
	"errors"
	"net/http"
)

// failMalformed401 builds a `malformed` refusal that carries the 401 itself,
// so a partner verifying by hand gets the status the SPEC promises (§5.1).
func (v *verifier) failMalformed401(format string, args ...any) error {
	err := v.fail(ErrCodeMalformed, format, args...)
	var re *RealmError
	if errors.As(err, &re) {
		re.HTTPStatus = http.StatusUnauthorized
	}
	return err
}

// accessTokenTyp is the issuer's own ADR-109 D9 allowlist: ASCII
// case-insensitive, NO trimming. The lowering is done by hand because
// strings.EqualFold folds Unicode and would widen the set.
func accessTokenTyp(typ *string) bool {
	if typ == nil {
		return false
	}
	switch asciiLower(*typ) {
	case "jwt", "at+jwt", "application/at+jwt":
		return true
	}
	return false
}

func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

// blankSub reports whether sub is empty or only ASCII whitespace (SPEC §5.1:
// exactly U+0020 and U+0009-U+000D). strings.TrimSpace would also strip U+00A0.
func blankSub(sub string) bool {
	for i := 0; i < len(sub); i++ {
		c := sub[i]
		if c != ' ' && (c < '\t' || c > '\r') {
			return false
		}
	}
	return true
}
