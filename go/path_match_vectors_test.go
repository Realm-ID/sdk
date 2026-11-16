package realmid

// SPEC11_4_1_canon + SPEC11_4_1_source (owner rulings 9 and 16, 2026-11-14;
// audit e-03/e-04). The shared vector file is the contract:
// sdk/testdata/path-match-vectors/vectors.json (README there). It sits OUTSIDE
// go/ on purpose (a file inside the module changes the module hash).

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

type pmvMatcher struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Pattern string `json:"pattern"`
	Path    string `json:"path"`
	Match   bool   `json:"match"`
}

type pmvRequest struct {
	ID     string `json:"id"`
	Target string `json:"target"`
	Go     struct {
		Seen    string  `json:"seen"`
		MFARule *string `json:"mfa_rule"`
	} `json:"go"`
}

type pmvFile struct {
	MatcherCaseCount int `json:"matcher_case_count"`
	RequestCaseCount int `json:"request_case_count"`
	Matcher          []pmvMatcher
	RequestRules     struct {
		MFA []string `json:"mfa"`
	} `json:"request_rules"`
	Request []pmvRequest `json:"request"`
}

func loadPMV(t *testing.T) pmvFile {
	t.Helper()
	raw, err := os.ReadFile("../testdata/path-match-vectors/vectors.json")
	if err != nil {
		t.Fatalf("vector file unreadable: %v", err)
	}
	var f pmvFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("vector file unparseable: %v", err)
	}
	return f
}

func TestSPEC11_4_1_canon_Vectors(t *testing.T) {
	f := loadPMV(t)
	ran, failed := 0, 0
	for _, c := range f.Matcher {
		ran++
		if got := canonicalMatch(c.Pattern, c.Kind, c.Path); got != c.Match {
			failed++
			t.Errorf("%s: canonicalMatch(%q, %q, %q) = %v, want %v", c.ID, c.Pattern, c.Kind, c.Path, got, c.Match)
		}
	}
	t.Logf("path-match-vectors go: matcher ran %d, %d failed", ran, failed)
	if ran == 0 || ran != f.MatcherCaseCount {
		t.Fatalf("ran %d matcher cases, file declares %d (a partial run is a failure)", ran, f.MatcherCaseCount)
	}
}

func okHandler(called *bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		*called = true
		w.WriteHeader(http.StatusNoContent)
	})
}

func TestSPEC11_4_1_source_Vectors(t *testing.T) {
	f := loadPMV(t)
	r, err := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: "http://127.0.0.1:1"})
	if err != nil {
		t.Fatal(err)
	}
	// "/**" exempt: a refusal must come BEFORE the exemption is consulted.
	mw := r.Middleware(MiddlewareOptions{ExemptPaths: []string{"/**"}})
	scope := ScopePolicy{Rules: []ScopeRule{{Path: "/**"}}}.Compile().Middleware(ScopeMiddlewareOptions{})
	rules := make([]MFARule, 0, len(f.RequestRules.MFA))
	for _, p := range f.RequestRules.MFA {
		rules = append(rules, MFARule{Path: p})
	}
	compiled := compileMFARules(rules)

	ran, failed := 0, 0
	for _, c := range f.Request {
		ran++
		for _, fallback := range []bool{false, true} {
			name := c.ID
			if fallback {
				name += "/in-process"
			}
			req := httptest.NewRequest("GET", c.Target, nil)
			if fallback {
				req.RequestURI = ""
			}
			bad := func(format string, a ...any) {
				failed++
				t.Errorf(name+": "+format, a...)
			}
			seen, ok := matchPathFor(req)
			if c.Go.Seen == "400" {
				if ok {
					bad("matchPathFor accepted %q (seen %q), want refusal", c.Target, seen)
				}
				for _, label := range []string{"middleware", "scope"} {
					called := false
					rec := httptest.NewRecorder()
					rq := httptest.NewRequest("GET", c.Target, nil)
					if fallback {
						rq.RequestURI = ""
					}
					wrapMW(label, mw, scope, okHandler(&called)).ServeHTTP(rec, rq)
					if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"invalid_path"`) || called {
						bad("%s: status %d called=%v body %s, want 400 invalid_path and no handler", label, rec.Code, called, rec.Body.String())
					}
				}
				continue
			}
			if !ok || seen != c.Go.Seen {
				bad("matchPathFor(%q) = %q ok=%v, want %q", c.Target, seen, ok, c.Go.Seen)
				continue
			}
			var got *string
			if rule := findMFARule(compiled, "GET", seen, nil); rule != nil {
				for i := range compiled {
					if &compiled[i] == rule {
						got = &f.RequestRules.MFA[i]
						break
					}
				}
			}
			if (got == nil) != (c.Go.MFARule == nil) || (got != nil && *got != *c.Go.MFARule) {
				bad("mfa rule for %q = %v, want %v", seen, got, c.Go.MFARule)
			}
		}
	}
	t.Logf("path-match-vectors go: ran %d request cases (x2 branches), %d failed", ran, failed)
	if ran == 0 || ran != f.RequestCaseCount {
		t.Fatalf("ran %d request cases, file declares %d (a partial run is a failure)", ran, f.RequestCaseCount)
	}
}

func wrapMW(label string, mw, scope func(http.Handler) http.Handler, next http.Handler) http.Handler {
	if label == "scope" {
		return scope(next)
	}
	return mw(next)
}
