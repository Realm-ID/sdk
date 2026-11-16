package realmid

// SPEC §11.4.1 — `{name}` path placeholders for ScopeRule and
// mfaProtectedPaths. exemptPaths never uses this: it keeps braces literal,
// because a placeholder there would widen an exemption (fail-open).

import (
	"net/http"
	"regexp"
	"strings"
)

// SPEC §11.4.1 SPEC11_4_1_canon — ONE canonical matcher for exemptPaths,
// mfaProtectedPaths and ScopeRule paths: one trailing slash is ignored on both
// sides and literals compare ASCII case-insensitively. Case is folded by
// lowercasing BOTH sides by hand, never with a regex (?i) flag: Go's (?i) folds
// U+017F to 's' and U+212A to 'k', which the other two languages do not.

// canonPath is the form both a pattern and a request path are compared in.
func canonPath(s string) string {
	if len(s) > 1 && s[len(s)-1] == '/' {
		s = s[:len(s)-1]
	}
	return asciiLower(s)
}

// canonicalRegex compiles pat for kind ("exempt" keeps braces literal; "mfa"
// and "scope" understand `{name}`). Match it against canonPath(path).
func canonicalRegex(pat, kind string) *regexp.Regexp {
	if kind == "exempt" {
		return globToRegex(canonPath(pat))
	}
	return placeholderGlobRegex(canonPath(pat))
}

// canonicalMatch is the single matcher of SPEC11_4_1_canon.
func canonicalMatch(pattern, kind, path string) bool {
	return canonicalRegex(pattern, kind).MatchString(canonPath(path))
}

// SPEC11_4_1_source (Go) — the path handed to the matcher is r.URL.Path. A
// request is refused (400 invalid_path) first when the raw path text holds
// %2F, %5C or %25 (hex case-insensitive) or a literal backslash, or when
// r.URL.Path has a dot segment (owner rulings 9 and 16, 2026-11-14).

// rawPathRefused reports whether raw (percent-encoded path text) holds an
// encoded slash, backslash or percent, or a literal backslash.
func rawPathRefused(raw string) bool {
	if strings.IndexByte(raw, '\\') >= 0 {
		return true
	}
	for i := 0; i+2 < len(raw); i++ {
		if raw[i] != '%' {
			continue
		}
		switch strings.ToUpper(raw[i+1 : i+3]) {
		case "2F", "5C", "25":
			return true
		}
	}
	return false
}

// hasDotSegment reports a "." or ".." segment, judged after the segment's
// ;params are removed (so "..;" counts).
func hasDotSegment(p string) bool {
	for _, seg := range strings.Split(p, "/") {
		if i := strings.IndexByte(seg, ';'); i >= 0 {
			seg = seg[:i]
		}
		if seg == "." || seg == ".." {
			return true
		}
	}
	return false
}

// wirePath extracts the path text from r.RequestURI: query removed and, in
// absolute form, scheme and authority removed.
func wirePath(uri string) string {
	if i := strings.IndexByte(uri, '?'); i >= 0 {
		uri = uri[:i]
	}
	if uri != "" && uri[0] != '/' {
		if i := strings.Index(uri, "://"); i >= 0 {
			rest := uri[i+3:]
			if j := strings.IndexByte(rest, '/'); j >= 0 {
				return rest[j:]
			}
			return ""
		}
	}
	return uri
}

// matchPathFor returns the path the gates match, or ok=false when the request
// must be answered 400 invalid_path.
func matchPathFor(req *http.Request) (string, bool) {
	if uri := req.RequestURI; uri != "" && uri != "*" {
		if rawPathRefused(wirePath(uri)) {
			return "", false
		}
	} else if rawPathRefused(req.URL.RawPath) || rawPathRefused(req.URL.EscapedPath()) {
		// In-process request: net/url leaves RawPath empty when the raw text
		// equals its default escaping, and EscapedPath() re-escapes the decoded
		// path when RawPath holds a character it will not keep, so scan both.
		return "", false
	}
	if hasDotSegment(req.URL.Path) {
		return "", false
	}
	return req.URL.Path, true
}

// writeInvalidPath answers the refusal of matchPathFor.
func writeInvalidPath(w http.ResponseWriter) {
	writeJSON(w, http.StatusBadRequest, map[string]any{
		"error": map[string]any{"code": "invalid_path", "message": "request path is not canonical"},
	})
}

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
