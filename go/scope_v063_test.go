package realmid

// SPEC §10.2 path syntax, §11.4 Missing on anyOf, §11.4.1 {name}, §11.5.1 writeDenied.

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

const goldenDenied = `{"error":{"code":"insufficient_scope","message":"this token does not carry the scope required for this route"}}`

func TestSPEC11_4_AnyOfDenialMissingIsTheFullList(t *testing.T) {
	p := ScopePolicy{Rules: []ScopeRule{
		{Path: "/r/**", Scopes: []string{"r:b", "r:a"}, AnyOf: true},
		{Path: "/w/**", Scopes: []string{"w:a", "w:b"}},
	}}.Compile()
	d := p.Decide(claimsWithScope("nope"), "GET", "/r/x")
	if d.Allowed || !reflect.DeepEqual(d.Missing, []string{"r:b", "r:a"}) {
		t.Fatalf("anyOf denial: %+v", d)
	}
	if d := p.Decide(claimsWithScope("r:a"), "GET", "/r/x"); !d.Allowed || len(d.Missing) != 0 {
		t.Fatalf("allowed must have empty Missing: %+v", d)
	}
	if d := p.Decide(claimsWithScope("w:a"), "GET", "/w/x"); !reflect.DeepEqual(d.Missing, []string{"w:b"}) {
		t.Fatalf("all-of denial lists the lacking subset: %+v", d)
	}
	if d := p.Decide(claimsWithScope("x"), "GET", "/unmatched"); d.Matched || len(d.Missing) != 0 {
		t.Fatalf("matched==false has no rule to be missing from: %+v", d)
	}
}

func TestSPEC11_4_1_PlaceholderTable(t *testing.T) {
	cases := []struct {
		pat, path string
		want      bool
	}{
		{"/orders/{id}", "/orders/42", true},
		{"/orders/{id}", "/orders/42/", false},
		{"/orders/{id}", "/orders/", false},
		{"/orders/{id}", "/orders", false},
		{"/orders/{id}", "/orders//42", false},
		{"/orders/{id}", "/orders/42/items", false},
		{"/orders/*", "/orders/", true},
		{"/orders/*", "/orders//42", false},
		{"/orders/**", "/orders/42/", true},
		{"/orders/**", "/orders", true},
		{"/orders/{id}/", "/orders/42/", true},
		{"/orgs/{org}/files/**", "/orgs/a/files/x/y", true},
		{"/{id}/{id}", "/a/b", true},
	}
	for _, c := range cases {
		p := ScopePolicy{Rules: []ScopeRule{{Path: c.pat, Scopes: []string{"s"}}}}.Compile()
		if got := p.Decide(claimsWithScope("s"), "GET", c.path).Matched; got != c.want {
			t.Errorf("%s vs %s: matched=%v want %v", c.pat, c.path, got, c.want)
		}
	}
}

func TestSPEC11_4_1_InvalidBraceFormsAreValidateErrorsAndInert(t *testing.T) {
	cases := map[string]string{
		"/files/{path:.*}": "regex placeholders are unsupported",
		"/a/{}":            "empty placeholder",
		"/a/{org id}":      "letters, digits, `_`, `-`",
		"/v{n}/x":          "whole path segment",
		"/files/{id}.json": "whole path segment",
		"/a/{id":           "unbalanced brace",
		"/a/id}":           "unbalanced brace",
		"/a/{{id}}":        "unbalanced brace",
	}
	for pat, msg := range cases {
		pol := ScopePolicy{Rules: []ScopeRule{{Path: pat, Scopes: []string{"s"}}}}
		errs := pol.Validate()
		if len(errs) != 1 || !strings.Contains(errs[0].Error(), msg) || !strings.Contains(errs[0].Error(), pat) {
			t.Errorf("%s: errs=%v want %q", pat, errs, msg)
		}
		// inert: no path matches, not even the literal text
		for _, path := range []string{pat, "/a/x", "/files/x", "/v1/x"} {
			if pol.Compile().Decide(claimsWithScope("s"), "GET", path).Matched {
				t.Errorf("%s must be inert but matched %s", pat, path)
			}
		}
	}
}

func TestSPEC10_2_MFAPathsPlaceholder(t *testing.T) {
	rules := compileMFARules([]MFARule{{Path: "/orders/{id}"}})
	for path, want := range map[string]bool{"/orders/42": true, "/orders/": false, "/orders/42/items": false} {
		if got := findMFARule(rules, "GET", path, nil) != nil; got != want {
			t.Errorf("%s: protected=%v want %v", path, got, want)
		}
	}
	if err := ValidateMFARules([]MFARule{{Path: "/a/{org id}"}}); err == nil {
		t.Error("an invalid brace form in mfaProtectedPaths must be refused at construction")
	}
	if err := ValidateMFARules([]MFARule{{Path: "/a/{id}"}}); err != nil {
		t.Errorf("valid placeholder refused: %v", err)
	}
	if findMFARule(compileMFARules([]MFARule{{Path: "/x/**"}}), "GET", "/x", nil) == nil {
		t.Error("/x/** protects the bare /x")
	}
}

func TestSPEC10_2_ExemptPathsStayLiteral(t *testing.T) {
	ex := compileGlobs([]string{"/hooks/{id}"})
	if matchAny(ex, "/hooks/abc") {
		t.Fatal("a placeholder in exemptPaths must NOT widen the exemption")
	}
	if !matchAny(ex, "/hooks/{id}") {
		t.Fatal("exemptPaths braces are literal text")
	}
	ex = compileGlobs([]string{"/x/**"})
	for _, p := range []string{"/x", "/x/", "/x/a/b"} {
		if !matchAny(ex, p) {
			t.Errorf("/x/** must exempt %s", p)
		}
	}
	if matchAny(ex, "/xy") {
		t.Error("/x/** must not exempt /xy")
	}
}

func denyAll() *CompiledScopePolicy {
	return ScopePolicy{Rules: []ScopeRule{{Path: "/p", Scopes: []string{"need"}}}}.Compile()
}

func serve(h http.Handler, path string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
	return w
}

func TestSPEC11_5_1_UnsetWriteDeniedIsByteIdentical(t *testing.T) {
	w := serve(denyAll().Middleware(ScopeMiddlewareOptions{})(http.NotFoundHandler()), "/p")
	if w.Code != 403 || w.Header().Get("Content-Type") != "application/json" || w.Body.String() != goldenDenied {
		t.Fatalf("%d %q %q", w.Code, w.Header().Get("Content-Type"), w.Body.String())
	}
}

func TestSPEC11_5_1_OrderAndStatusDefaults(t *testing.T) {
	var order []string
	opts := ScopeMiddlewareOptions{
		OnScopeDenied: func(*http.Request, ScopeDecision) { order = append(order, "observe") },
		WriteDenied: func(w http.ResponseWriter, _ *http.Request, d ScopeDecision) {
			order = append(order, "write")
			_, _ = w.Write([]byte("custom"))
		},
	}
	called := false
	h := denyAll().Middleware(opts)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	w := serve(h, "/p")
	if w.Code != 403 || w.Body.String() != "custom" || strings.Join(order, ",") != "observe,write" || called {
		t.Fatalf("%d %q %v called=%v", w.Code, w.Body.String(), order, called)
	}
	if ct := w.Header().Get("Content-Type"); strings.Contains(ct, "json") {
		t.Fatalf("SDK sets no Content-Type in hook mode, got %q", ct)
	}
	// hook writes nothing -> 403, empty body
	h = denyAll().Middleware(ScopeMiddlewareOptions{WriteDenied: func(http.ResponseWriter, *http.Request, ScopeDecision) {}})(http.NotFoundHandler())
	if w := serve(h, "/p"); w.Code != 403 || w.Body.Len() != 0 {
		t.Fatalf("empty hook: %d %q", w.Code, w.Body.String())
	}
	// explicit WriteHeader honoured
	h = denyAll().Middleware(ScopeMiddlewareOptions{WriteDenied: func(w http.ResponseWriter, _ *http.Request, _ ScopeDecision) {
		w.WriteHeader(http.StatusUnauthorized)
	}})(http.NotFoundHandler())
	if w := serve(h, "/p"); w.Code != 401 {
		t.Fatalf("explicit status: %d", w.Code)
	}
}

func TestSPEC11_5_1_RunsOnEveryDenialKindAndNeverOnAllowed(t *testing.T) {
	var seen []ScopeDecision
	opts := ScopeMiddlewareOptions{WriteDenied: func(w http.ResponseWriter, _ *http.Request, d ScopeDecision) {
		seen = append(seen, d)
		w.WriteHeader(403)
	}}
	h := denyAll().Middleware(opts)(http.NotFoundHandler())
	serve(h, "/p")         // matched, unsatisfied
	serve(h, "/unmatched") // default deny
	var nilPolicy *CompiledScopePolicy
	serve(nilPolicy.Middleware(opts)(http.NotFoundHandler()), "/p") // nil policy
	if len(seen) != 3 || !seen[0].Matched || seen[1].Matched || seen[2].Matched {
		t.Fatalf("decisions: %+v", seen)
	}
	pub := ScopePolicy{Rules: []ScopeRule{{Path: "/open", Public: true}}}.Compile()
	n := len(seen)
	serve(pub.Middleware(opts)(http.NotFoundHandler()), "/open")
	if len(seen) != n {
		t.Fatal("writeDenied must not run on an allowed request")
	}
}
