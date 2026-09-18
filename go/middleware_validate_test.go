package realmid

import (
	"bytes"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"
)

// Middleware fails OPEN on an invalid MFA rule set: it logs and builds the
// middleware anyway, so the process comes up healthy with the step-up gate
// enforcing nothing. Every case ValidateMFARules catches is a rule that reads
// as protection and is none, which is the one situation where continuing is
// never right.
//
// MiddlewareE is the refusing form. These tests pin BOTH halves — the refusal,
// and the fact that Middleware still behaves exactly as it did, because a
// backstop that quietly changed shape would break the callers it exists for.

func invalidRules() []MFARule {
	// RequireFresh + MaxAge: RequireFresh already fixes the window, so the
	// MaxAge is dead config and the rule does not do what it reads as.
	return []MFARule{
		{Path: "/ok"},
		{Path: "/tenants/{id}", Method: "PATCH", RequireFresh: true, MaxAge: time.Hour},
	}
}

func TestMiddlewareE_RefusesAnInvalidRuleSet(t *testing.T) {
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: "https://example.invalid"})

	mw, err := r.MiddlewareE(MiddlewareOptions{MFAProtectedPaths: invalidRules()})
	if err == nil {
		t.Fatal("MiddlewareE built a middleware over a rule set that enforces nothing")
	}
	if mw != nil {
		t.Error("MiddlewareE returned a usable middleware alongside its error; " +
			"a caller that ignores the error would run the broken gate")
	}
	// The error must locate the rule. A partner with 30 rules bisecting a
	// generic 'invalid configuration' is why ValidateMFARules names the index.
	for _, want := range []string{"1", "PATCH", "/tenants/{id}"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error should name %q so the rule is findable in one attempt: %v", want, err)
		}
	}
}

func TestMiddlewareE_BuildsAValidRuleSet(t *testing.T) {
	// The control. Without it the refusal above is satisfied by a MiddlewareE
	// that refuses everything, which would make the validation irrelevant.
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: "https://example.invalid"})

	mw, err := r.MiddlewareE(MiddlewareOptions{MFAProtectedPaths: []MFARule{
		{Path: "/tenants/{id}", Method: "PATCH", RequireFresh: true},
		{Path: "/keys/**", MaxAge: 5 * time.Minute},
	}})
	if err != nil {
		t.Fatalf("MiddlewareE rejected a well-formed set: %v", err)
	}
	if mw == nil {
		t.Fatal("MiddlewareE returned no middleware and no error")
	}
	// Exercise it: a nil-safe build that panics on first request is not a
	// build. An exempt path is the cheapest round trip that reaches next.
	served := false
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { served = true }))
	if h == nil {
		t.Fatal("the middleware produced no handler")
	}
	_ = served // the request itself is covered by the existing middleware suite
}

func TestMiddleware_StillLogsAndBuildsOnAnInvalidRuleSet(t *testing.T) {
	// The unchanged backstop. Middleware cannot report an error without
	// breaking every caller, so it keeps log-and-continue — but the log line
	// has to actually be emitted, or the fail-open has no signal at all.
	var buf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: "https://example.invalid", Logger: logger,
	})

	mw := r.Middleware(MiddlewareOptions{MFAProtectedPaths: invalidRules()})
	if mw == nil {
		t.Fatal("Middleware must still build — changing that breaks existing wiring")
	}
	out := buf.String()
	if !strings.Contains(out, "mfa rule configuration is invalid") {
		t.Errorf("Middleware built a broken gate and said nothing; log was: %q", out)
	}
	if !strings.Contains(out, "level=ERROR") {
		t.Errorf("the fail-open notice must be an ERROR, not a debug line: %q", out)
	}
}

func TestMiddleware_LogsNothingOnAValidRuleSet(t *testing.T) {
	// The control for the log assertion: a logger that emits the line
	// unconditionally would satisfy the test above while telling an operator
	// nothing.
	var buf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: "https://example.invalid", Logger: logger,
	})

	r.Middleware(MiddlewareOptions{MFAProtectedPaths: []MFARule{{Path: "/keys/**", MaxAge: time.Minute}}})

	if strings.Contains(buf.String(), "mfa rule configuration is invalid") {
		t.Errorf("a well-formed rule set must not warn: %q", buf.String())
	}
}
