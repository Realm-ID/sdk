package realmid

import (
	"strings"
	"testing"
)

// TestRoleScopes_ScopesForUnionsAndNormalises: the output goes on the wire and
// into RolePermissions, so it must be a SET — sorted and de-duplicated — not
// whatever order two maps happened to iterate in. Two identical grants that
// serialise differently are indistinguishable from two different grants in a
// log or a diff.
func TestRoleScopes_ScopesForUnionsAndNormalises(t *testing.T) {
	m := RoleScopes{
		"dispatcher": {"orders:read", "orders:assign"},
		"accountant": {"invoices:read", "orders:read"},
		"observer":   {"orders:read"},
	}

	got := m.ScopesFor("dispatcher", "accountant")
	want := "invoices:read orders:assign orders:read"
	if strings.Join(got, " ") != want {
		t.Errorf("ScopesFor = %v, want %q (sorted, de-duplicated union)", got, want)
	}

	// Order of the ROLES must not change the result either.
	if reversed := m.ScopesFor("accountant", "dispatcher"); strings.Join(reversed, " ") != want {
		t.Errorf("role order changed the result: %v", reversed)
	}
}

// TestRoleScopes_UnknownRoleContributesNothing is the fail-closed rule, and it
// is deliberately SILENT: a user holding a role the map does not know gets
// fewer scopes and is refused at the gate. Erroring instead would lock people
// out of the product over a config gap, which is why Validate exists to catch
// the gap at startup rather than at login.
func TestRoleScopes_UnknownRoleContributesNothing(t *testing.T) {
	m := RoleScopes{"known": {"a:read"}}

	if got := m.ScopesFor("ghost"); got != nil {
		t.Errorf("an unknown role conferred %v; it must confer nothing", got)
	}
	if got := m.ScopesFor("known", "ghost"); len(got) != 1 || got[0] != "a:read" {
		t.Errorf("an unknown role alongside a known one changed the result: %v", got)
	}

	// nil, not an empty slice: the caller must be able to tell "confers
	// nothing" from "I did not ask", because passing nil to RolePermissions
	// omits the field (do not narrow) while an empty slice narrows to nothing.
	if got := m.ScopesFor(); got != nil {
		t.Errorf("ScopesFor() with no roles = %v, want nil", got)
	}
	if got := (RoleScopes{}).ScopesFor("known"); got != nil {
		t.Errorf("an empty map conferred %v, want nil", got)
	}
}

// TestRoleScopes_ValidateCatchesTheGapsThatCostAuthority. Each of these is a
// config error whose symptom appears at request time, far from the typo:
// an unmatched role name, a role that silently confers nothing, and a scope the
// issuer will refuse at mint.
func TestRoleScopes_Validate(t *testing.T) {
	if errs := (RoleScopes{"ok": {"orders:read"}}).Validate(); len(errs) != 0 {
		t.Fatalf("a valid map reported %v", errs)
	}

	for _, tc := range []struct {
		name string
		m    RoleScopes
		want string
	}{
		{"empty role name", RoleScopes{"": {"a:read"}}, "role name is empty"},
		{"role confers nothing", RoleScopes{"idle": {}}, "maps to no scopes"},
		{"illegal scope token", RoleScopes{"bad": {"has space"}}, "not a legal RFC 6749 scope token"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			errs := tc.m.Validate()
			if len(errs) == 0 {
				t.Fatalf("Validate accepted %#v", tc.m)
			}
			if !strings.Contains(errs[0].Error(), tc.want) {
				t.Errorf("error = %q, want it to mention %q", errs[0].Error(), tc.want)
			}
			// The message must name the map it is about, so an operator reading
			// a boot log knows which of the two scope maps to open.
			if !strings.Contains(errs[0].Error(), "role scopes") {
				t.Errorf("error %q does not say which map it is about", errs[0].Error())
			}
		})
	}
}

// TestRoleScopes_RolesIsSorted: used for a startup log line and for asserting
// coverage in a partner's own tests, so it must not depend on map iteration.
func TestRoleScopes_Roles(t *testing.T) {
	m := RoleScopes{"zulu": {"a:read"}, "alpha": {"b:read"}, "mike": {"c:read"}}
	if got := strings.Join(m.Roles(), ","); got != "alpha,mike,zulu" {
		t.Errorf("Roles() = %s, want alpha,mike,zulu", got)
	}
	if got := (RoleScopes{}).Roles(); len(got) != 0 {
		t.Errorf("empty map Roles() = %v", got)
	}
}
