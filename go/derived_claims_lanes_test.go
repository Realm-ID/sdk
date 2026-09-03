package realmid

import (
	"context"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

// derived_claims_lanes_test.go — the SET of lanes that must resolve the derived
// claims is DERIVED FROM THE PACKAGE, never written down.
//
// # Why this file exists
//
// `middleware_derived_claims_test.go` opens with a comment saying
// `mintProductRoles` "had three call sites — Login, CompleteLogin,
// PasswordLogin". That sentence was accurate when it was written and is a
// HAND-MAINTAINED LIST, which is how the fourth lane (MFAVerify) shipped
// returning a claim-blind session with every existing test green. Writing this
// guard then found a FIFTH (OTPLogin) that the defect report — filed off a
// careful read of the same three-call-site comment — had not named either.
//
// Two hand-maintained lists, two missed lanes. So the subject list is computed:
// every function in the package that hands a caller a `*Session` is a lane, and
// a new one is a test failure on the day it is written rather than on the day a
// partner notices their tokens are role-blind.
//
// This is the same rule as the issuer's `TestRoleWriteSitesAreReviewed`, and the
// same rule this workspace reached for after four hand-maintained subject lists
// decayed in one day.
//
// # What counts as covered
//
// Reachability, not a direct call: `MFAVerifyOTP` delegates to `MFAVerify`, and
// a lane that delegates to a covered lane is covered. The walk is intra-package
// and method-name-based, which is coarse — two methods with the same name on
// different receivers are conflated. That is deliberate: the failure mode of
// being coarse is a lane wrongly reported COVERED only if a same-named method
// elsewhere mints, which does not occur in this package and would be caught by
// the behavioural tests next door. The failure mode of being precise and wrong
// is a guard that silently stops covering something.

// derivedClaimsMint is the sink every session-producing lane must reach.
const derivedClaimsMint = "mintProductRoles"

// exemptLanes are functions returning *Session that legitimately do NOT resolve
// the derived claims. Each needs a REASON, and the reason must be about the
// lane, not about convenience.
//
// It is deliberately empty. An exemption is the mechanism by which this guard
// would stop guarding, so adding one should feel like a decision.
var exemptLanes = map[string]string{}

// pkgFuncs is one parsed function: its body's intra-package callees.
type pkgFunc struct {
	name     string
	pos      token.Position
	returnsS bool
	calls    map[string]bool
}

func parsePackageFuncs(t *testing.T) map[string]*pkgFunc {
	t.Helper()
	fset := token.NewFileSet()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package dir: %v", err)
	}
	funcs := map[string]*pkgFunc{}
	var files int
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, filepath.Join(".", name), nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		files++
		for _, decl := range f.Decls {
			fd, ok := decl.(*ast.FuncDecl)
			if !ok || fd.Body == nil {
				continue
			}
			pf := &pkgFunc{
				name:     fd.Name.Name,
				pos:      fset.Position(fd.Pos()),
				returnsS: returnsSessionPtr(fd),
				calls:    map[string]bool{},
			}
			ast.Inspect(fd.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				switch fn := call.Fun.(type) {
				case *ast.Ident:
					pf.calls[fn.Name] = true
				case *ast.SelectorExpr:
					pf.calls[fn.Sel.Name] = true
				}
				return true
			})
			// Same-named methods on different receivers: keep the one that
			// reaches the mint, so a conflation can only ever UNDER-report
			// coverage (a false failure a human reads), never over-report it.
			if prev, dup := funcs[pf.name]; !dup || (!prev.calls[derivedClaimsMint] && pf.calls[derivedClaimsMint]) {
				funcs[pf.name] = pf
			}
		}
	}
	if files == 0 {
		t.Fatal("parsed no package files — the guard would pass vacuously")
	}
	return funcs
}

// returnsSessionPtr reports whether fd hands the caller a *Session.
func returnsSessionPtr(fd *ast.FuncDecl) bool {
	if fd.Type.Results == nil {
		return false
	}
	for _, r := range fd.Type.Results.List {
		star, ok := r.Type.(*ast.StarExpr)
		if !ok {
			continue
		}
		if id, ok := star.X.(*ast.Ident); ok && id.Name == "Session" {
			return true
		}
	}
	return false
}

// reaches reports whether `from` can reach `sink` through intra-package calls.
func reaches(funcs map[string]*pkgFunc, from, sink string, seen map[string]bool) bool {
	if seen[from] {
		return false
	}
	seen[from] = true
	fn, ok := funcs[from]
	if !ok {
		return false
	}
	if fn.calls[sink] {
		return true
	}
	for callee := range fn.calls {
		if reaches(funcs, callee, sink, seen) {
			return true
		}
	}
	return false
}

// TestDerivedClaimLanesAreDerivedFromThePackage fails when a function that hands
// back a *Session cannot reach the derived-claims mint.
func TestDerivedClaimLanesAreDerivedFromThePackage(t *testing.T) {
	funcs := parsePackageFuncs(t)

	if _, ok := funcs[derivedClaimsMint]; !ok {
		t.Fatalf("%s is not in the package — this guard is keyed on a name that no "+
			"longer exists and would pass vacuously from here on", derivedClaimsMint)
	}

	var lanes, uncovered []string
	for name, fn := range funcs {
		if !fn.returnsS || name == derivedClaimsMint {
			continue
		}
		lanes = append(lanes, name)
		if _, exempt := exemptLanes[name]; exempt {
			continue
		}
		if !reaches(funcs, name, derivedClaimsMint, map[string]bool{}) {
			uncovered = append(uncovered, name+" ("+fn.pos.Filename+":"+strconv.Itoa(fn.pos.Line)+")")
		}
	}
	sort.Strings(lanes)
	sort.Strings(uncovered)

	// A guard with no subjects is not a passing guard.
	if len(lanes) < 4 {
		t.Fatalf("found only %d session-producing lanes (%v) — the package has at "+
			"least Login/OTPLogin/PasswordLogin/MFAVerify/MFAVerifyOTP, so the "+
			"detection is broken and this test is not checking anything",
			len(lanes), lanes)
	}
	if len(uncovered) > 0 {
		t.Errorf("these lanes hand back a *Session that never reaches %s, so the token "+
			"carries no product_roles and no scope:\n  %s\n\nAn ADR-097/102 partner is "+
			"denied everywhere on such a token. Either call the mint, or add the lane to "+
			"exemptLanes WITH A REASON.",
			derivedClaimsMint, strings.Join(uncovered, "\n  "))
	}
	t.Logf("%d session-producing lanes checked against %s: %s",
		len(lanes), derivedClaimsMint, strings.Join(lanes, ", "))
}

// ---- Behavioural cover for the two lanes the AST guard found ----------------
//
// The guard above proves the mint is REACHABLE. These prove it actually runs and
// that the handler is given the right (tenant, user) — the AST cannot tell a
// wired call from a dead one behind a condition that is never true.
//
// Lane-specific on purpose, per the rule in middleware_derived_claims_test.go:
// an assertion that "a login carries the claim" passed throughout the entire
// life of the original bug.

// laneThenTokenServer answers `path` with a settled single-tenant session and
// records the /auth/token mint that follows.
func laneThenTokenServer(t *testing.T, path string, capture *map[string]any, calls *int32) *httptest.Server {
	t.Helper()
	return authTestServer(t, map[string]http.HandlerFunc{
		path: func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"refresh_token": "rtok",
				"user":          map[string]any{"id": "u1"},
				"tenants":       []any{map[string]any{"tenant_id": "t1", "role": "owner"}},
			})
		},
		"/auth/token": func(w http.ResponseWriter, r *http.Request) {
			atomic.AddInt32(calls, 1)
			buf, _ := io.ReadAll(r.Body)
			var body map[string]any
			_ = json.Unmarshal(buf, &body)
			*capture = body
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":  "minted",
				"refresh_token": "rtok2",
				"expires_in":    900,
			})
		},
	})
}

// TestDerivedClaims_OTPLoginResolves — an OTP login is a login. This lane was
// uncovered and no report had named it.
func TestDerivedClaims_OTPLoginResolves(t *testing.T) {
	var got map[string]any
	var calls int32
	srv := laneThenTokenServer(t, "/auth/login", &got, &calls)
	defer srv.Close()

	var sawTenant, sawUser string
	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
		Scopes: func(_ context.Context, tenantID, userID string) ([]string, error) {
			sawTenant, sawUser = tenantID, userID
			return []string{"invoices:read"}, nil
		},
	})
	if _, err := r.Auth.OTPLogin(context.Background(), OTPLoginRequest{
		Identifier: "u@example.com", Presented: "123456",
	}); err != nil {
		t.Fatalf("otp login: %v", err)
	}
	if calls != 1 {
		t.Fatalf("want exactly one /auth/token mint on the OTP lane, got %d", calls)
	}
	if sawTenant != "t1" || sawUser != "u1" {
		t.Errorf("handler got (%q,%q), want (t1,u1)", sawTenant, sawUser)
	}
	if s, _ := got["scope"].(string); s != "invoices:read" {
		t.Errorf("scope on the OTP-login mint = %#v, want invoices:read", got["scope"])
	}
}

// TestDerivedClaims_MFAVerifyResolves — the step-up lane issues the token the
// user carries for the rest of the session, so a claim-blind one here denies a
// partner's own gate at the worst possible moment: right after a passed factor.
func TestDerivedClaims_MFAVerifyResolves(t *testing.T) {
	var got map[string]any
	var calls int32
	srv := laneThenTokenServer(t, "/auth/mfa/verify", &got, &calls)
	defer srv.Close()

	var sawTenant, sawUser string
	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
		ProductRoles: func(_ context.Context, tenantID, userID string) ([]string, error) {
			sawTenant, sawUser = tenantID, userID
			return []string{"dispatch"}, nil
		},
	})
	if _, err := r.Auth.MFAVerify(context.Background(), MFAVerifyRequest{
		ChallengeToken: "mfa", Code: "000000",
	}); err != nil {
		t.Fatalf("mfa verify: %v", err)
	}
	if calls != 1 {
		t.Fatalf("want exactly one /auth/token mint on the MFA lane, got %d", calls)
	}
	if sawTenant != "t1" || sawUser != "u1" {
		t.Errorf("handler got (%q,%q), want (t1,u1)", sawTenant, sawUser)
	}
	roles, _ := got["product_roles"].([]any)
	if len(roles) != 1 || roles[0] != "dispatch" {
		t.Errorf("product_roles on the MFA mint = %#v, want [dispatch]", got["product_roles"])
	}
}

// MFAVerifyOTP delegates to MFAVerify. The AST guard reports it covered THROUGH
// that delegation; this proves the delegation is real rather than a same-named
// method the walk conflated.
func TestDerivedClaims_MFAVerifyOTPInheritsTheMint(t *testing.T) {
	var got map[string]any
	var calls int32
	srv := laneThenTokenServer(t, "/auth/mfa/verify", &got, &calls)
	defer srv.Close()

	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
		Scopes: func(_ context.Context, _, _ string) ([]string, error) {
			return []string{"invoices:read"}, nil
		},
	})
	if _, err := r.Auth.MFAVerifyOTP(context.Background(), MFAVerifyOTPRequest{
		MFAToken: "mfa", Presented: "000000",
	}); err != nil {
		t.Fatalf("mfa verify otp: %v", err)
	}
	if calls != 1 {
		t.Fatalf("want exactly one /auth/token mint via MFAVerifyOTP, got %d", calls)
	}
	if s, _ := got["scope"].(string); s != "invoices:read" {
		t.Errorf("scope via MFAVerifyOTP = %#v, want invoices:read", got["scope"])
	}
}
