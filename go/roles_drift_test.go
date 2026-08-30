package realmid

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Cross-repo drift test for the two hand-maintained lists in roles_authority.go.
//
// THE ISSUER WINS. `ConfersAuthority` needs no list at all — it reads the
// ACTION off the permission string, so it cannot drift. These two CAN:
//
//	humanOnlyPermissions  ← issuer internal/realmrole/assignable.go
//	systemUnassignable    ← issuer internal/realmrole/store.go (NonAssignableRoles)
//
// This test parses the issuer's own source when a checkout is reachable and
// fails on any difference. That is the case in the RealmID workspace, where
// `sdk/` and `issuer/` are siblings, and in any CI that checks both out.
//
// WHEN THE ISSUER IS NOT REACHABLE the check cannot run, and it says so in
// large letters rather than reporting a pass it did not earn. `Realm-ID/sdk`'s
// own CI clones only this repo, so that is the standalone-CI case; wiring the
// issuer into it (or moving this check to the umbrella repo's cross-repo CI) is
// filed in sdk/TODO.md. A skipped gate is not a verdict — read the log line.
const driftCheckUnreachable = "" +
	"DRIFT CHECK DID NOT RUN: no issuer checkout found. " +
	"The lists in roles_authority.go were NOT compared against " +
	"issuer/internal/realmrole/. This is not a pass. See sdk/TODO.md."

// findIssuerRealmrole walks up from the working directory looking for a
// sibling issuer checkout. Returns "" when there is none.
func findIssuerRealmrole() string {
	dir, err := os.Getwd()
	if err != nil {
		return ""
	}
	for i := 0; i < 8; i++ {
		cand := filepath.Join(dir, "issuer", "internal", "realmrole")
		if st, err := os.Stat(filepath.Join(cand, "permissions.go")); err == nil && !st.IsDir() {
			return cand
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return ""
}

func parseIssuerFile(t *testing.T, path string) *ast.File {
	t.Helper()
	f, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ParseComments)
	if err != nil {
		// NOT a skip: the file is there and we could not read it. A gate that
		// treats input it cannot parse as input that passed is worse than none.
		t.Fatalf("parse issuer source %s: %v", path, err)
	}
	return f
}

// issuerPermConsts collects `PermX = "resource:action"` from permissions.go.
func issuerPermConsts(t *testing.T, f *ast.File) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, d := range f.Decls {
		gd, ok := d.(*ast.GenDecl)
		if !ok || gd.Tok != token.CONST {
			continue
		}
		for _, s := range gd.Specs {
			vs, ok := s.(*ast.ValueSpec)
			if !ok || len(vs.Names) != len(vs.Values) {
				continue
			}
			for i, n := range vs.Names {
				lit, ok := vs.Values[i].(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					continue
				}
				v, err := strconv.Unquote(lit.Value)
				if err != nil {
					continue
				}
				out[n.Name] = v
			}
		}
	}
	if len(out) == 0 {
		t.Fatalf("no Perm* constants found in the issuer's permissions.go — the parse silently matched nothing")
	}
	return out
}

// issuerMapKeys returns the composite-literal keys of a top-level `var name = map[...]...{...}`.
// Identifier keys come back as the identifier; string-literal keys as the string.
func issuerMapKeys(t *testing.T, f *ast.File, name string) []string {
	t.Helper()
	var keys []string
	found := false
	for _, d := range f.Decls {
		gd, ok := d.(*ast.GenDecl)
		if !ok || gd.Tok != token.VAR {
			continue
		}
		for _, s := range gd.Specs {
			vs, ok := s.(*ast.ValueSpec)
			if !ok {
				continue
			}
			for i, n := range vs.Names {
				if n.Name != name || i >= len(vs.Values) {
					continue
				}
				cl, ok := vs.Values[i].(*ast.CompositeLit)
				if !ok {
					t.Fatalf("issuer %s is not a composite literal any more — re-read the source", name)
				}
				found = true
				for _, el := range cl.Elts {
					kv, ok := el.(*ast.KeyValueExpr)
					if !ok {
						t.Fatalf("issuer %s has a non key/value element — re-read the source", name)
					}
					switch k := kv.Key.(type) {
					case *ast.Ident:
						keys = append(keys, k.Name)
					case *ast.BasicLit:
						v, err := strconv.Unquote(k.Value)
						if err != nil {
							t.Fatalf("issuer %s: unquote key %s: %v", name, k.Value, err)
						}
						keys = append(keys, v)
					default:
						t.Fatalf("issuer %s has an unrecognised key expression — re-read the source", name)
					}
				}
			}
		}
	}
	if !found {
		t.Fatalf("issuer var %s not found — it was renamed or moved; this SDK copy is now unanchored", name)
	}
	if len(keys) == 0 {
		t.Fatalf("issuer %s parsed to ZERO keys — refusing to compare against nothing", name)
	}
	return keys
}

func setEqual(t *testing.T, what string, got map[string]struct{}, want []string) {
	t.Helper()
	wantSet := map[string]struct{}{}
	for _, w := range want {
		wantSet[w] = struct{}{}
	}
	for w := range wantSet {
		if _, ok := got[w]; !ok {
			t.Errorf("%s DRIFT: the issuer has %q and the SDK does not — the issuer wins, add it", what, w)
		}
	}
	for g := range got {
		if _, ok := wantSet[g]; !ok {
			t.Errorf("%s DRIFT: the SDK has %q and the issuer does not — the issuer wins, remove it", what, g)
		}
	}
}

func TestRolePredicatesMatchTheIssuer(t *testing.T) {
	dir := findIssuerRealmrole()
	if dir == "" {
		t.Log(driftCheckUnreachable)
		return
	}
	t.Logf("drift check running against %s", dir)

	permsFile := parseIssuerFile(t, filepath.Join(dir, "permissions.go"))
	assignFile := parseIssuerFile(t, filepath.Join(dir, "assignable.go"))
	storeFile := parseIssuerFile(t, filepath.Join(dir, "store.go"))

	consts := issuerPermConsts(t, permsFile)

	// 1. humanOnlyPermissions ← realmrole.HumanOnlyPermissions (identifier keys).
	var wantHumanOnly []string
	for _, ident := range issuerMapKeys(t, assignFile, "HumanOnlyPermissions") {
		v, ok := consts[ident]
		if !ok {
			t.Fatalf("issuer HumanOnlyPermissions names %s, which is not a Perm* string constant", ident)
		}
		wantHumanOnly = append(wantHumanOnly, v)
	}
	setEqual(t, "humanOnlyPermissions", humanOnlyPermissions, wantHumanOnly)

	// 2. systemUnassignable ← realmrole.NonAssignableRoles (string-literal keys).
	setEqual(t, "systemUnassignable", systemUnassignable, issuerMapKeys(t, storeFile, "NonAssignableRoles"))
}

// TestConfersAuthorityRuleMatchesTheIssuer pins the RULE, not a list: the
// issuer derives "mutating" from `p.Action != "read"` over the ADR-074 catalog.
// Our copy derives it from the permission STRING's action segment, which is the
// same rule without needing the catalog. If the issuer ever stops deriving it
// that way, this SDK predicate stops being equivalent and must be revisited.
func TestConfersAuthorityRuleMatchesTheIssuer(t *testing.T) {
	dir := findIssuerRealmrole()
	if dir == "" {
		t.Log(driftCheckUnreachable)
		return
	}
	src, err := os.ReadFile(filepath.Join(dir, "permissions.go"))
	if err != nil {
		t.Fatalf("read issuer permissions.go: %v", err)
	}
	if !strings.Contains(string(src), `p.Action != "read"`) {
		t.Errorf(`issuer no longer derives the mutating set from p.Action != "read" — ` +
			`ConfersAuthority in roles_authority.go is no longer equivalent to the issuer's`)
	}
	if !strings.Contains(string(src), "func ConfersAuthority(perms []string) bool") {
		t.Errorf("issuer realmrole.ConfersAuthority changed shape — re-derive the SDK copy")
	}
}

// TestNoPerRoleMFAFloorInTheIssuer is the ADR-101 interlock. The console's
// predicate carried a required_mfa_methods floor; the SDK deliberately does
// not, because ADR-101 retired the field. If the issuer ever reinstates a
// role-level MFA gate on the assignability path, this SDK predicate is
// under-filtering and pickers will start offering choices that 400.
func TestNoPerRoleMFAFloorInTheIssuer(t *testing.T) {
	dir := findIssuerRealmrole()
	if dir == "" {
		t.Log(driftCheckUnreachable)
		return
	}
	gate := filepath.Join(dir, "..", "httpapi", "role_assignable.go")
	src, err := os.ReadFile(gate)
	if err != nil {
		t.Fatalf("read issuer role_assignable.go: %v", err)
	}
	body := string(src)
	i := strings.Index(body, "func requireRoleAssignableToKind(")
	if i < 0 {
		t.Fatalf("issuer requireRoleAssignableToKind not found — the enforcement point moved")
	}
	if strings.Contains(body[i:], "FirstUnsatisfiableMFAMethod(") {
		t.Errorf("the issuer's assignability gate applies a per-role MFA floor again; " +
			"IsRoleAssignableTo in roles_authority.go does not and is now under-filtering")
	}
}
