package realmid

import (
	"strings"
	"testing"
	"time"
)

// A2-go part 1 — the SDK's MFARule model grows the two things the BFF's
// `api/internal/stepup` had and it did not: JSON-body narrowing, and
// config validation that refuses a policy which cannot fire.
//
// The ROUTE LIST stays partner-owned data (ADR-096 D2). This is the model
// only; nothing here names a RealmID route.

func TestValidateMFARules_AcceptsAWellFormedSet(t *testing.T) {
	err := ValidateMFARules([]MFARule{
		{Path: "/tenants/{id}", Method: "PATCH", RequireFresh: true},
		{Path: "/keys/**", MaxAge: 5 * time.Minute},
		{Path: "/tenants/{id}", Method: "PATCH", WhenJSONField: "status", WhenJSONValues: []string{"inactive"}},
	})
	if err != nil {
		t.Errorf("ValidateMFARules rejected a well-formed set: %v", err)
	}
	if err := ValidateMFARules(nil); err != nil {
		t.Errorf("an empty rule set is valid (the gate is simply off): %v", err)
	}
}

func TestValidateMFARules_RefusesAnEmptyPath(t *testing.T) {
	// compileMFARules SKIPS an empty path, so an authoring slip silently
	// removes protection. Validation is how that becomes visible.
	err := ValidateMFARules([]MFARule{{Path: "", RequireFresh: true}})
	if err == nil {
		t.Fatalf("an empty path must be refused, not silently dropped")
	}
	if !strings.Contains(err.Error(), "path") {
		t.Errorf("error should name the problem: %v", err)
	}
}

func TestValidateMFARules_RefusesRequireFreshWithMaxAge(t *testing.T) {
	err := ValidateMFARules([]MFARule{{Path: "/x", RequireFresh: true, MaxAge: time.Hour}})
	if err == nil {
		t.Fatalf("require_fresh + max_age is a policy that is not enforced as written")
	}
}

func TestValidateMFARules_RefusesAConditionThatCanNeverFire(t *testing.T) {
	if err := ValidateMFARules([]MFARule{
		{Path: "/x", WhenJSONField: "status"},
	}); err == nil {
		t.Errorf("a field with no values matches nothing — reads as protection and is none")
	}
	if err := ValidateMFARules([]MFARule{
		{Path: "/x", WhenJSONValues: []string{"inactive"}},
	}); err == nil {
		t.Errorf("values with no field must be refused")
	}
}

func TestValidateMFARules_NamesTheOffendingIndexAndRoute(t *testing.T) {
	err := ValidateMFARules([]MFARule{
		{Path: "/ok"},
		{Path: "/tenants/{id}", Method: "PATCH", RequireFresh: true, MaxAge: time.Hour},
	})
	if err == nil {
		t.Fatalf("expected a rejection")
	}
	for _, want := range []string{"1", "PATCH", "/tenants/{id}"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not name %q — a partner has to guess which rule", err, want)
		}
	}
}

func TestMFARuleEffectiveMaxAge(t *testing.T) {
	def := 15 * time.Minute
	if got := (MFARule{RequireFresh: true}).EffectiveMaxAge(def); got != MFARequireFreshWindow {
		t.Errorf("RequireFresh window = %v, want %v", got, MFARequireFreshWindow)
	}
	if got := (MFARule{MaxAge: time.Minute}).EffectiveMaxAge(def); got != time.Minute {
		t.Errorf("explicit MaxAge = %v, want 1m", got)
	}
	if got := (MFARule{}).EffectiveMaxAge(def); got != def {
		t.Errorf("zero MaxAge = %v, want the default %v", got, def)
	}
	if got := (MFARule{MaxAge: -time.Minute}).EffectiveMaxAge(def); got != def {
		t.Errorf("negative MaxAge = %v, want the default %v", got, def)
	}
}

// ---- matching ----

func TestFindMFARule_MethodNarrowsTheMatch(t *testing.T) {
	rules := compileMFARules([]MFARule{{Path: "/tenants/{id}", Method: "DELETE", RequireFresh: true}})
	if findMFARule(rules, "DELETE", "/tenants/t-1", nil) == nil {
		t.Errorf("DELETE /tenants/t-1 should match")
	}
	if findMFARule(rules, "GET", "/tenants/t-1", nil) != nil {
		t.Errorf("GET must not match a DELETE-scoped rule")
	}
	// Lowercase from a proxy must still match — HTTP methods compare
	// case-insensitively here, as they do in the BFF.
	if findMFARule(rules, "delete", "/tenants/t-1", nil) == nil {
		t.Errorf("method comparison must be case-insensitive")
	}
}

func TestFindMFARule_EmptyMethodMatchesAnyMethod(t *testing.T) {
	rules := compileMFARules([]MFARule{{Path: "/keys/**"}})
	for _, m := range []string{"GET", "POST", "DELETE"} {
		if findMFARule(rules, m, "/keys/k-1", nil) == nil {
			t.Errorf("empty Method must match %s", m)
		}
	}
}

func TestFindMFARule_PlaceholderMatchesExactlyOneSegment(t *testing.T) {
	rules := compileMFARules([]MFARule{{Path: "/tenants/{id}/users"}})
	if findMFARule(rules, "POST", "/tenants/t-1/users", nil) == nil {
		t.Errorf("{id} must match one segment")
	}
	if findMFARule(rules, "POST", "/tenants/t-1/x/users", nil) != nil {
		t.Errorf("{id} must not span a slash")
	}
	if findMFARule(rules, "POST", "/tenants//users", nil) != nil {
		t.Errorf("{id} must not match an EMPTY segment")
	}
}

func TestFindMFARule_GlobsStillWork(t *testing.T) {
	rules := compileMFARules([]MFARule{{Path: "/admin/**"}})
	if findMFARule(rules, "GET", "/admin/anything/deep", nil) == nil {
		t.Errorf("existing ** glob behaviour must not regress")
	}
	if findMFARule(rules, "GET", "/public", nil) != nil {
		t.Errorf("/public must not match /admin/**")
	}
}

func TestFindMFARule_QueryStringIsIgnored(t *testing.T) {
	rules := compileMFARules([]MFARule{{Path: "/tenants/{id}"}})
	if findMFARule(rules, "GET", "/tenants/t-1?expand=owner", nil) == nil {
		t.Errorf("a query string must not defeat the match")
	}
}

func TestFindMFARule_JSONNarrowingSelectsOnlyTheNamedValue(t *testing.T) {
	// The shape this exists for: PATCH /tenants/{id} is both "rename an org"
	// and "deactivate an org"; only the second is irreversible. Gating both
	// trains people to click through the prompt, which is how a step-up stops
	// being a control.
	rules := compileMFARules([]MFARule{
		{Path: "/tenants/{id}", Method: "PATCH", WhenJSONField: "status", WhenJSONValues: []string{"inactive", "suspended"}, RequireFresh: true},
	})
	if findMFARule(rules, "PATCH", "/tenants/t-1", []byte(`{"status":"inactive"}`)) == nil {
		t.Errorf("the deactivate variant must be gated")
	}
	if findMFARule(rules, "PATCH", "/tenants/t-1", []byte(`{"status":"suspended"}`)) == nil {
		t.Errorf("every listed value must be gated")
	}
	if findMFARule(rules, "PATCH", "/tenants/t-1", []byte(`{"display_name":"New name"}`)) != nil {
		t.Errorf("the rename variant must NOT be gated")
	}
	if findMFARule(rules, "PATCH", "/tenants/t-1", []byte(`{"status":"active"}`)) != nil {
		t.Errorf("an unlisted value must not be gated")
	}
}

func TestFindMFARule_UnreadableBodyDoesNotMatchAConditionedRule(t *testing.T) {
	// A conditioned policy NARROWS a broader route, so a non-match means the
	// request is treated as the un-gated variant — and the issuer rejects an
	// unparseable body anyway. A condition used to WIDEN a gate would need the
	// opposite default; that is why this is asserted rather than assumed.
	rules := compileMFARules([]MFARule{
		{Path: "/tenants/{id}", Method: "PATCH", WhenJSONField: "status", WhenJSONValues: []string{"inactive"}},
	})
	for name, body := range map[string][]byte{
		"empty":      nil,
		"not json":   []byte("garbage"),
		"json array": []byte(`["status"]`),
		"non string": []byte(`{"status":7}`),
	} {
		if findMFARule(rules, "PATCH", "/tenants/t-1", body) != nil {
			t.Errorf("%s: an unreadable body must not satisfy a JSON condition", name)
		}
	}
}

func TestFindMFARule_UnconditionedRuleIgnoresTheBody(t *testing.T) {
	rules := compileMFARules([]MFARule{{Path: "/tenants/{id}", Method: "PATCH", RequireFresh: true}})
	if findMFARule(rules, "PATCH", "/tenants/t-1", nil) == nil {
		t.Errorf("a rule with no condition must match with no body at all")
	}
}

func TestFindMFARule_FirstMatchWins(t *testing.T) {
	// A narrow conditioned rule placed before a broad one must win, so a
	// partner can express "fresh for deactivate, 15m for everything else".
	rules := compileMFARules([]MFARule{
		{Path: "/tenants/{id}", Method: "PATCH", WhenJSONField: "status", WhenJSONValues: []string{"inactive"}, RequireFresh: true},
		{Path: "/tenants/{id}", Method: "PATCH", MaxAge: time.Hour},
	})
	got := findMFARule(rules, "PATCH", "/tenants/t-1", []byte(`{"status":"inactive"}`))
	if got == nil || !got.requireFresh {
		t.Fatalf("the narrower rule must win: %+v", got)
	}
	got = findMFARule(rules, "PATCH", "/tenants/t-1", []byte(`{"display_name":"x"}`))
	if got == nil || got.requireFresh || got.maxAge != time.Hour {
		t.Fatalf("the broad rule must catch the un-narrowed request: %+v", got)
	}
}

func TestCompileMFARules_NeedsABodyOnlyWhenSomeRuleAsksForOne(t *testing.T) {
	// The middleware must not buffer request bodies for partners who never
	// configured a JSON condition.
	if mfaRulesNeedBody(compileMFARules([]MFARule{{Path: "/a"}, {Path: "/b", RequireFresh: true}})) {
		t.Errorf("no rule declares a condition; the body must not be read")
	}
	if !mfaRulesNeedBody(compileMFARules([]MFARule{
		{Path: "/a"},
		{Path: "/b", WhenJSONField: "status", WhenJSONValues: []string{"inactive"}},
	})) {
		t.Errorf("a conditioned rule requires the body")
	}
}
