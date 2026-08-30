package realmid

import "testing"

// ADR-101 D6 — ConfersAuthority is derived from the grants, never the name.

func TestConfersAuthority_ReadOnlyRoleDoesNot(t *testing.T) {
	if ConfersAuthority([]string{"users:read", "audit:read", "roles:read"}) {
		t.Errorf("a role granting only :read actions must not confer authority")
	}
}

func TestConfersAuthority_EmptyAndNilDoNot(t *testing.T) {
	if ConfersAuthority(nil) {
		t.Errorf("nil grants must not confer authority")
	}
	if ConfersAuthority([]string{}) {
		t.Errorf("empty grants must not confer authority")
	}
}

func TestConfersAuthority_AnyNonReadActionDoes(t *testing.T) {
	// Every non-read action in the ADR-074 catalog, not just "manage".
	for _, p := range []string{
		"users:manage", "sessions:revoke", "signing_keys:rotate", "platform:config",
	} {
		if !ConfersAuthority([]string{"users:read", p}) {
			t.Errorf("%q has a non-read action and must confer authority", p)
		}
	}
}

func TestConfersAuthority_NameIsNotTheRule(t *testing.T) {
	// A role literally called "admin" holding nothing confers nothing; a role
	// called "reporting" that can revoke sessions confers authority. This is
	// the whole point of D6.
	if ConfersAuthority(nil) {
		t.Errorf("an empty role must not confer authority whatever it is called")
	}
	if !ConfersAuthority([]string{"sessions:revoke"}) {
		t.Errorf("a non-read grant confers authority whatever the role is called")
	}
}

func TestConfersAuthority_MalformedEntryFailsClosed(t *testing.T) {
	// No colon at all — unparseable, so it must be read as conferring.
	if !ConfersAuthority([]string{"garbage"}) {
		t.Errorf("a permission with no colon must fail CLOSED (conferring)")
	}
	// Colon with an empty action is equally unparseable.
	if !ConfersAuthority([]string{"users:"}) {
		t.Errorf("a permission with an empty action must fail CLOSED (conferring)")
	}
	// An empty string is not a grant at all and must not be read as authority.
	if ConfersAuthority([]string{""}) {
		t.Errorf("an empty permission string is not a grant and must not confer")
	}
}

func TestConfersAuthority_UnknownResourceWithReadActionDoesNot(t *testing.T) {
	// The predicate reads the ACTION, so a resource the SDK has never heard of
	// is classified correctly the day the issuer adds it.
	if ConfersAuthority([]string{"widgets:read"}) {
		t.Errorf("an unknown resource with a read action must not confer authority")
	}
	if !ConfersAuthority([]string{"widgets:manage"}) {
		t.Errorf("an unknown resource with a non-read action must confer authority")
	}
}

func TestRoleObjectConfersAuthority(t *testing.T) {
	if (&RoleObject{Name: "admin", Permissions: []string{"users:read"}}).ConfersAuthority() {
		t.Errorf("RoleObject.ConfersAuthority must read Permissions, not Name")
	}
	if !(&RoleObject{Name: "reporting", Permissions: []string{"audit:read", "users:manage"}}).ConfersAuthority() {
		t.Errorf("RoleObject.ConfersAuthority missed a non-read grant")
	}
	var nilRole *RoleObject
	if nilRole.ConfersAuthority() {
		t.Errorf("a nil role must not confer authority")
	}
}

// ---- ADR-081 assignability ----

func TestIsRoleAssignableTo_SystemUnassignableNamesAreNeverAssignable(t *testing.T) {
	for _, name := range []string{"owner", "platform_api", "platform_mgmt_api"} {
		r := &RoleObject{Name: name, AssignableTo: []string{PrincipalHuman, PrincipalService}}
		if IsRoleAssignableTo(r, PrincipalHuman) || IsRoleAssignableTo(r, PrincipalService) {
			t.Errorf("%q is in the issuer's NonAssignableRoles and must never be offered", name)
		}
	}
}

func TestIsRoleAssignableTo_DisabledRoleIsNotAssignable(t *testing.T) {
	r := &RoleObject{Name: "support", Disabled: true, AssignableTo: []string{PrincipalHuman}}
	if IsRoleAssignableTo(r, PrincipalHuman) {
		t.Errorf("a disabled role must not be offered")
	}
}

func TestIsRoleAssignableTo_EmptyAssignableToMeansAny(t *testing.T) {
	// Read-time fails OPEN: a response from an issuer older than v0.57.0 omits
	// the field, and degrading to "any" reproduces pre-ADR-081 behaviour rather
	// than emptying every picker.
	r := &RoleObject{Name: "support"}
	if !IsRoleAssignableTo(r, PrincipalHuman) || !IsRoleAssignableTo(r, PrincipalService) {
		t.Errorf("absent assignable_to must be treated as ANY")
	}
}

func TestIsRoleAssignableTo_DeclaredKindIsHonoured(t *testing.T) {
	r := &RoleObject{Name: "support", AssignableTo: []string{PrincipalHuman}}
	if !IsRoleAssignableTo(r, PrincipalHuman) {
		t.Errorf("human-declared role must be assignable to a human")
	}
	if IsRoleAssignableTo(r, PrincipalService) {
		t.Errorf("human-declared role must not be assignable to a service")
	}
}

func TestIsRoleAssignableTo_HumanOnlyPermissionFloorAppliesToServiceOnly(t *testing.T) {
	// ADR-081 §2.3: a floor, not a default — it holds even though the partner
	// declared the role service-assignable.
	r := &RoleObject{
		Name:         "ops",
		Permissions:  []string{"users:read", "signing_keys:rotate"},
		AssignableTo: []string{PrincipalHuman, PrincipalService},
	}
	if IsRoleAssignableTo(r, PrincipalService) {
		t.Errorf("a service principal may never hold a role granting signing_keys:rotate")
	}
	if !IsRoleAssignableTo(r, PrincipalHuman) {
		t.Errorf("the §2.3 floor applies to services only; a human may hold it")
	}
}

func TestIsRoleAssignableTo_SystemRoleIsExemptFromTheFloor(t *testing.T) {
	// ADR-091: the §2.3 floor scopes to PARTNER-AUTHORED roles. An RI-managed
	// system role is the realm's machine identity by construction and D3 grants
	// it realm-control permissions on purpose.
	r := &RoleObject{
		Name:         "some_system_bot",
		IsSystem:     true,
		Permissions:  []string{"platform:config"},
		AssignableTo: []string{PrincipalService},
	}
	if !IsRoleAssignableTo(r, PrincipalService) {
		t.Errorf("an is_system role is exempt from the human-only floor (ADR-091)")
	}
}

func TestIsRoleAssignableTo_NoPerRoleMFAFloor(t *testing.T) {
	// ADR-101 retired required_mfa_methods. The SDK must NOT resurrect the
	// check — this test exists so a well-meaning "port the console file"
	// re-adding it goes red. A role is judged on its GRANTS and its declared
	// kinds, nothing else.
	r := &RoleObject{
		Name:         "support",
		Permissions:  []string{"users:read"},
		AssignableTo: []string{PrincipalService},
	}
	if !IsRoleAssignableTo(r, PrincipalService) {
		t.Errorf("no per-role MFA floor may gate assignability after ADR-101")
	}
}

func TestIsRoleAssignableTo_NilRole(t *testing.T) {
	if IsRoleAssignableTo(nil, PrincipalHuman) {
		t.Errorf("a nil role must not be reported assignable")
	}
}

func TestIsRoleAssignableTo_UnknownKindIsRefused(t *testing.T) {
	r := &RoleObject{Name: "support", AssignableTo: []string{PrincipalHuman, PrincipalService}}
	if IsRoleAssignableTo(r, "bot") {
		t.Errorf("`bot` is ADR-072 sources.type vocabulary, not users.kind — must be refused")
	}
	if IsRoleAssignableTo(r, "") {
		t.Errorf("an empty kind must be refused")
	}
}

func TestRolesAssignableTo_FiltersAndPreservesOrder(t *testing.T) {
	roles := []RoleObject{
		{Name: "owner", AssignableTo: []string{PrincipalHuman}},
		{Name: "member", AssignableTo: []string{PrincipalHuman, PrincipalService}},
		{Name: "ops", Permissions: []string{"domains:manage"}, AssignableTo: []string{PrincipalHuman, PrincipalService}},
		{Name: "reader", AssignableTo: []string{PrincipalHuman, PrincipalService}},
		{Name: "gone", Disabled: true, AssignableTo: []string{PrincipalService}},
	}
	got := RolesAssignableTo(roles, PrincipalService)
	want := []string{"member", "reader"}
	if len(got) != len(want) {
		t.Fatalf("RolesAssignableTo(service) = %d roles, want %d (%v)", len(got), len(want), namesOf(got))
	}
	for i := range want {
		if got[i].Name != want[i] {
			t.Errorf("RolesAssignableTo[%d] = %q, want %q", i, got[i].Name, want[i])
		}
	}
	if got := RolesAssignableTo(nil, PrincipalHuman); got == nil || len(got) != 0 {
		t.Errorf("RolesAssignableTo(nil) must return an empty non-nil slice, got %v", got)
	}
}

func namesOf(rs []RoleObject) []string {
	out := make([]string, 0, len(rs))
	for _, r := range rs {
		out = append(out, r.Name)
	}
	return out
}
