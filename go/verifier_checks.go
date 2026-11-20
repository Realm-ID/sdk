package realmid

// failMalformed401 builds a `malformed` refusal; fail itself stamps the 401
// SPEC §3.1 promises, so this is the same call under its older name.
func (v *verifier) failMalformed401(format string, args ...any) error {
	return v.fail(ErrCodeMalformed, format, args...)
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
