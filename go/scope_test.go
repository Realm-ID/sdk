package realmid

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func claimsWithScope(s string) *Claims {
	return &Claims{Extra: map[string]any{"scope": s}}
}

// TestScopeAllows_FailsClosed walks every way the predicate can be asked a
// question it cannot answer. Each one must be false.
//
// The empty-required case is the one worth arguing about: ScopeAllows(c) with
// no scopes returns FALSE, not true. Vacuous-true on an empty requirement is
// how a gate silently stops gating — a route someone forgot to configure would
// pass every caller — and a genuinely public route is declared, not inferred.
func TestScopeAllows_FailsClosed(t *testing.T) {
	full := claimsWithScope("a b c")
	cases := []struct {
		name     string
		claims   *Claims
		required []string
		want     bool
	}{
		{"nil claims", nil, []string{"a"}, false},
		{"no scope claim", &Claims{}, []string{"a"}, false},
		{"empty scope claim", claimsWithScope(""), []string{"a"}, false},
		{"whitespace-only scope claim", claimsWithScope("   "), []string{"a"}, false},
		{"no required scopes is NOT vacuously true", full, nil, false},
		{"single hit", full, []string{"b"}, true},
		{"all-of, all present", full, []string{"a", "c"}, true},
		{"all-of, one missing", full, []string{"a", "z"}, false},
		// No pattern matching, exactly as CapAllows states it.
		{"no prefix implication", claimsWithScope("read"), []string{"read:orders"}, false},
		{"no suffix implication", claimsWithScope("read:orders"), []string{"read"}, false},
		{"no wildcard expansion", claimsWithScope("*"), []string{"anything"}, false},
		{"case-sensitive", claimsWithScope("read"), []string{"Read"}, false},
		// The claim is a STRING, not an array (RFC 9068 §2.2.3).
		{"array-shaped claim is not read", &Claims{Extra: map[string]any{"scope": []any{"a"}}}, []string{"a"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ScopeAllows(tc.claims, tc.required...); got != tc.want {
				t.Errorf("ScopeAllows(%v) = %v, want %v", tc.required, got, tc.want)
			}
		})
	}
}

func TestScopeAllowsAny(t *testing.T) {
	c := claimsWithScope("a b")
	if !ScopeAllowsAny(c, "z", "b") {
		t.Error("any-of must pass on a single hit")
	}
	if ScopeAllowsAny(c, "y", "z") {
		t.Error("any-of must fail when none hit")
	}
	if ScopeAllowsAny(c) {
		t.Error("any-of with no required scopes must be false, not vacuously true")
	}
	if ScopeAllowsAny(nil, "a") {
		t.Error("any-of must fail closed on nil claims")
	}
	// The two predicates must genuinely differ, or one of them is decoration.
	if ScopeAllows(c, "a", "z") == ScopeAllowsAny(c, "a", "z") {
		t.Error("all-of and any-of agree on a partially-held set; one of them is not doing its job")
	}
}

func TestScopesFrom_PreservesOrderAndSplitsOnRuns(t *testing.T) {
	got := ScopesFrom(claimsWithScope("c  a   b"))
	if !reflect.DeepEqual(got, []string{"c", "a", "b"}) {
		t.Errorf("ScopesFrom = %v, want the issuer's order preserved", got)
	}
	if ScopesFrom(nil) != nil {
		t.Error("ScopesFrom(nil) must be nil")
	}
}

// TestScopePolicy_DeniesByDefault is the property that makes the route map
// safe: adding an endpoint and forgetting to declare its scope produces a
// LOCKED DOOR, not an open one.
func TestScopePolicy_DeniesByDefault(t *testing.T) {
	p := ScopePolicy{Rules: []ScopeRule{
		{Path: "/orders/**", Scopes: []string{"orders:read"}},
	}}.Compile()
	c := claimsWithScope("orders:read admin")

	// PRECONDITION: the declared route is allowed, so the denial below is
	// attributable to the missing declaration and not to a broken policy.
	if !p.Decide(c, "GET", "/orders/42").Allowed {
		t.Fatal("PRECONDITION FAILED — the declared route must be allowed")
	}

	d := p.Decide(c, "GET", "/invoices/42")
	if d.Allowed {
		t.Error("an UNDECLARED route must be denied, even to a token carrying every scope")
	}
	if d.Matched {
		t.Error("Matched must be false so a caller can tell a config gap from an authz failure")
	}

	// A nil policy denies too — a wiring mistake must not look like a
	// deliberately open service.
	var nilPolicy *CompiledScopePolicy
	if nilPolicy.Decide(c, "GET", "/orders/42").Allowed {
		t.Error("a nil policy must deny")
	}
}

func TestScopePolicy_PublicAnyOfMethodAndOrder(t *testing.T) {
	p := ScopePolicy{Rules: []ScopeRule{
		{Path: "/health", Public: true},
		{Path: "/orders/*/export", Scopes: []string{"orders:export"}},
		{Path: "/orders/**", Method: "GET", Scopes: []string{"orders:read"}},
		{Path: "/orders/**", Scopes: []string{"orders:write", "orders:read"}},
		{Path: "/reports/**", Scopes: []string{"r:a", "r:b"}, AnyOf: true},
	}}.Compile()

	t.Run("public needs no token at all", func(t *testing.T) {
		if !p.Decide(nil, "GET", "/health").Allowed {
			t.Error("a Public route must allow a request with no claims")
		}
	})
	t.Run("method narrows", func(t *testing.T) {
		read := claimsWithScope("orders:read")
		if !p.Decide(read, "GET", "/orders/7").Allowed {
			t.Error("GET must match the read rule")
		}
		if p.Decide(read, "POST", "/orders/7").Allowed {
			t.Error("POST must fall through to the write rule and be denied")
		}
	})
	t.Run("first match wins, so a specific rule placed first narrows", func(t *testing.T) {
		// /orders/7/export matches BOTH the export rule and the GET rule. The
		// export rule is first, so it decides — a token holding only orders:read
		// must be refused there.
		read := claimsWithScope("orders:read")
		d := p.Decide(read, "GET", "/orders/7/export")
		if d.Allowed {
			t.Error("the earlier, more specific rule must decide")
		}
		if !reflect.DeepEqual(d.Required, []string{"orders:export"}) {
			t.Errorf("the export rule should have matched, got Required=%v", d.Required)
		}
	})
	t.Run("all-of is the default and any-of must be asked for", func(t *testing.T) {
		half := claimsWithScope("orders:read")
		if p.Decide(half, "POST", "/orders/7").Allowed {
			t.Error("a two-scope rule must require BOTH by default")
		}
		if !p.Decide(claimsWithScope("r:a"), "GET", "/reports/x").Allowed {
			t.Error("AnyOf must pass on one of two")
		}
	})
	t.Run("Missing names the gap, and only on an all-of denial", func(t *testing.T) {
		d := p.Decide(claimsWithScope("orders:read"), "POST", "/orders/7")
		if !reflect.DeepEqual(d.Missing, []string{"orders:write"}) {
			t.Errorf("Missing = %v, want [orders:write]", d.Missing)
		}
		if any := p.Decide(claimsWithScope("nope"), "GET", "/reports/x"); len(any.Missing) != 0 {
			t.Errorf("an AnyOf denial has no single missing scope; got %v", any.Missing)
		}
	})
}

// TestScopePolicy_ValidateCatchesConfigErrors — these are the mistakes a
// partner makes once and should learn about at startup, not from traffic.
func TestScopePolicy_ValidateCatchesConfigErrors(t *testing.T) {
	errs := ScopePolicy{Rules: []ScopeRule{
		{Path: "", Scopes: []string{"a"}},
		{Path: "/a", Public: true, Scopes: []string{"a"}},
		{Path: "/b"},
		{Path: "/c", Scopes: []string{"has space"}},
		{Path: "/ok", Scopes: []string{"fine"}},
	}}.Validate()
	if len(errs) != 4 {
		t.Fatalf("want 4 errors (empty path, public-with-scopes, no-scopes-not-public, bad charset), got %d: %v",
			len(errs), errs)
	}
	// Every error names its rule, or a partner with a 40-route map cannot find it.
	for _, e := range errs {
		ce, ok := e.(*ScopeConfigError)
		if !ok {
			t.Fatalf("want *ScopeConfigError, got %T", e)
		}
		if ce.Error() == "" {
			t.Error("a config error must render")
		}
	}
	if errs := (ScopePolicy{Rules: []ScopeRule{{Path: "/ok", Scopes: []string{"fine"}}}}).Validate(); len(errs) != 0 {
		t.Errorf("a valid policy must produce no errors, got %v", errs)
	}
}

// TestScopeMiddleware_403AndDoesNotLeakTheScopeNames.
//
// Telling an unauthorized caller which permissions they lack hands out a map of
// the API's authority model for free. The names go to the SERVER, through
// OnScopeDenied.
func TestScopeMiddleware_403AndDoesNotLeakTheScopeNames(t *testing.T) {
	p := ScopePolicy{Rules: []ScopeRule{
		{Path: "/secret", Scopes: []string{"very:secret:permission"}},
	}}.Compile()

	var seen ScopeDecision
	var called bool
	h := p.Middleware(ScopeMiddlewareOptions{
		OnScopeDenied: func(_ *http.Request, d ScopeDecision) { seen, called = d, true },
	})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))

	// Denied: no claims on the context at all.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/secret", nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if body := rec.Body.String(); !contains(body, "insufficient_scope") {
		t.Errorf("body should carry the RFC 6750 §3.1 code, got %s", body)
	}
	if body := rec.Body.String(); contains(body, "very:secret:permission") {
		t.Errorf("the 403 body LEAKED the required scope name: %s", body)
	}
	if !called {
		t.Fatal("OnScopeDenied must fire, or the names are lost to the server too")
	}
	if len(seen.Missing) != 1 || seen.Missing[0] != "very:secret:permission" {
		t.Errorf("the server-side hook must carry the missing names, got %v", seen.Missing)
	}

	// PRECONDITION for the negative above: with the scope, the handler runs.
	// Without this, a middleware that refused everything would pass every
	// assertion so far.
	req := httptest.NewRequest("GET", "/secret", nil)
	req = req.WithContext(context.WithValue(req.Context(), claimsKey, claimsWithScope("very:secret:permission")))
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, req)
	if rec2.Code != http.StatusTeapot {
		t.Fatalf("an authorized request must reach the handler; status = %d", rec2.Code)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
