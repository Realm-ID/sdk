package realmid

// SPEC §11.4.1 — `{name}` path placeholders for ScopeRule and
// mfaProtectedPaths. exemptPaths never uses this: it keeps braces literal,
// because a placeholder there would widen an exemption (fail-open).

import (
	"net/http"
	"regexp"
	"strings"
)

// inertRegexp matches no string at all.
var inertRegexp = regexp.MustCompile(`[^\s\S]`)

func isPlaceholderNameChar(c byte) bool {
	return c == '_' || c == '-' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// placeholderProblem returns "" for a valid pattern, else the §11.4.1 message
// for the first offending brace form.
func placeholderProblem(pat string) string {
	for i := 0; i < len(pat); i++ {
		switch pat[i] {
		case '}':
			return "unbalanced brace"
		case '{':
			end := strings.IndexByte(pat[i:], '}')
			if end < 0 {
				return "unbalanced brace"
			}
			name := pat[i+1 : i+end]
			switch {
			case strings.ContainsRune(name, '{'):
				return "unbalanced brace"
			case strings.ContainsRune(name, ':'):
				return "regex placeholders are unsupported; use `*` for one segment or `**` for any depth"
			case name == "":
				return "empty placeholder"
			}
			for j := 0; j < len(name); j++ {
				if !isPlaceholderNameChar(name[j]) {
					return "name may contain only letters, digits, `_`, `-`"
				}
			}
			after := i + end + 1
			if i == 0 || pat[i-1] != '/' || (after < len(pat) && pat[after] != '/') {
				return "a placeholder must be a whole path segment"
			}
			i += end
		}
	}
	return ""
}

// placeholderGlobRegex compiles a glob that also understands `{name}` (exactly
// one non-empty segment). An invalid brace form compiles to a pattern that
// matches NOTHING — inert, never a literal.
func placeholderGlobRegex(pat string) *regexp.Regexp {
	if !strings.ContainsAny(pat, "{}") {
		return globToRegex(pat)
	}
	if placeholderProblem(pat) != "" {
		return inertRegexp
	}
	var sb strings.Builder
	sb.WriteString("^")
	for len(pat) > 0 {
		i := strings.IndexByte(pat, '{')
		if i < 0 {
			sb.WriteString(globBody(pat))
			break
		}
		sb.WriteString(globBody(pat[:i]))
		sb.WriteString("[^/]+")
		pat = pat[i+strings.IndexByte(pat[i:], '}')+1:]
	}
	sb.WriteString("$")
	re, err := regexp.Compile(sb.String())
	if err != nil {
		return inertRegexp
	}
	return re
}

func globBody(piece string) string {
	if piece == "" {
		return ""
	}
	return strings.TrimSuffix(strings.TrimPrefix(globToRegex(piece).String(), "^"), "$")
}

// scopeDenialWriter lets the WriteDenied hook own headers and body while the
// SDK guarantees the status is 403 unless the hook chose another, and that the
// response always ends (SPEC §11.5.1).
type scopeDenialWriter struct {
	http.ResponseWriter
	wrote bool
}

func (s *scopeDenialWriter) WriteHeader(code int) {
	s.wrote = true
	s.ResponseWriter.WriteHeader(code)
}

func (s *scopeDenialWriter) Write(b []byte) (int, error) {
	if !s.wrote {
		s.WriteHeader(http.StatusForbidden)
	}
	return s.ResponseWriter.Write(b)
}
