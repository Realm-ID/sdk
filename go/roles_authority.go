package realmid

import "strings"

// Role predicates — "does this role confer authority" (ADR-101 D6) and "may a
// principal of this kind hold it" (ADR-081).
//
// ⚠️ THE ISSUER WINS. These are client-side mirrors of
// `issuer/internal/realmrole/permissions.go` (ConfersAuthority /
// IsMutatingPermission), `issuer/internal/realmrole/assignable.go`
// (HumanOnlyPermissions, AssignableToKind) and
// `issuer/internal/realmrole/store.go` (NonAssignableRoles). NOTHING HERE IS A
// SECURITY CONTROL: every assignment path is validated server-side and answers
// `400 role_not_assignable_to_kind` or `403 role_owner_only`. They exist so a
// partner console never OFFERS a choice whose every save fails — the ADR-090 /
// v0.84.0 bug class.
//
// Drift is the standing risk ADR-081 § Consequences names, so the two lists
// below are compared against the issuer's own source by
// `TestRolePredicatesMatchTheIssuer` in roles_drift_test.go. If a rule here and
// a rule there ever disagree, this file is the thing to fix.

// Principal kinds — the `users.kind` vocabulary (ADR-071), which is also the
// `assignable_to` vocabulary (ADR-081).
//
// Deliberately NOT ADR-072's `sources.type` ({web, android, ios, desktop, bot}):
// the constraint is about the principal holding the role, never about the client
// it signs in from. `service` is the correct word here, not `bot`.
const (
	PrincipalHuman   = "human"
	PrincipalService = "service"
)

// systemUnassignable are the role names the issuer never accepts on an
// assignment path, whatever their permissions say — mirrors
// realmrole.NonAssignableRoles.
//
//   - `owner` moves via the ADR-076 ownership pointer, not by assignment.
//   - `platform_api` backs the API-key bot (ADR-041).
//   - `platform_mgmt_api` is the only identity permitted to mint platform_api's
//     key (ADR-091 D3); a human holding it would be a credential-issuance path
//     outside the owner pointer, which is exactly what ADR-101 D6 closes.
var systemUnassignable = map[string]struct{}{
	"owner":             {},
	"platform_api":      {},
	"platform_mgmt_api": {},
}

// humanOnlyPermissions (ADR-081 §2.3) are the grants that require a human in
// the loop: each is a path by which a leaked machine credential escalates to
// realm-wide control. A service account may never hold a role carrying one,
// INDEPENDENT of what the role declares in assignable_to — this is a floor, not
// a default. Mirrors realmrole.HumanOnlyPermissions.
//
// Read counterparts are all permitted; only the mutating realm-control grants
// are listed.
var humanOnlyPermissions = map[string]struct{}{
	"signing_keys:rotate": {}, // realm-wide credential operation
	"domains:manage":      {}, // changes the realm's identity surface
	"platform:config":     {}, // realm-wide policy
	"federation:manage":   {}, // establishes cross-realm trust
}

// ConfersAuthority reports whether holding perms grants any power to CHANGE
// something, as opposed to a purely read-only role.
//
// This is ADR-101 D6: only a tenant's OWNER may seat a principal at a role that
// confers authority, on every one of the four paths that put a role on a
// principal (invite, role change, bulk import, service-account create). The
// issuer enforces it and answers `403 role_owner_only`; use this to keep a role
// picker from offering a choice whose every save would fail.
//
// DERIVED FROM THE GRANTS, NEVER FROM THE NAME. That is the whole point of D6:
// "admin" is a string. A realm may hold a role called `admin` with no
// permissions, and a role called `reporting` that can revoke sessions. The rule
// is "grants anything whose ACTION is not `read`", which is exactly how the
// issuer derives it from the ADR-074 catalog — so a permission RealmID adds
// tomorrow is classified correctly with no change here and no list to forget.
//
// A permission is `resource:action`. A MALFORMED entry — no colon, or an empty
// action — is treated as CONFERRING. That is the fail-closed direction: an
// entry we cannot parse must not be read as harmless. An empty string is not a
// grant at all and confers nothing.
func ConfersAuthority(perms []string) bool {
	for _, p := range perms {
		if p == "" {
			continue
		}
		colon := strings.IndexByte(p, ':')
		if colon < 0 {
			return true
		}
		if p[colon+1:] != "read" {
			return true
		}
	}
	return false
}

// ConfersAuthority reports whether this role confers administrative authority
// (ADR-101 D6). See the package-level ConfersAuthority for the rule. A nil role
// confers nothing — a caller that could not resolve the role has a different
// problem to report.
func (r *RoleObject) ConfersAuthority() bool {
	if r == nil {
		return false
	}
	return ConfersAuthority(r.Permissions)
}

// IsRoleAssignableTo reports whether a principal of `kind` may hold `role`.
//
// `kind` is PrincipalHuman or PrincipalService; anything else is refused,
// because the only other kind-shaped vocabulary in this system is ADR-072's
// `sources.type` and silently accepting `bot` here would answer a question
// nobody asked.
//
// The rules, in the issuer's order:
//
//  1. A system-unassignable NAME (owner, platform_api, platform_mgmt_api) is
//     never assignable, whatever its permissions say.
//  2. A disabled role is not assignable — it stays in the catalog but is hidden.
//  3. The role's declared `assignable_to` must admit the kind. EMPTY OR ABSENT
//     MEANS ANY: since ADR-081 § Amendment 2 the issuer never stores it empty,
//     so this branch only fires for a response from an issuer older than
//     v0.57.0 that omits the field, and degrading to "any" reproduces
//     pre-ADR-081 behaviour rather than emptying every picker. Read-time fails
//     OPEN; write-time is where the rule is enforced.
//  4. For a SERVICE principal only, the ADR-081 §2.3 human-only floor applies —
//     unless the role is `is_system`, which ADR-091 exempts: the two RI-managed
//     bot roles are the realm's machine identity by construction and are
//     granted realm-control permissions on purpose.
//
// There is deliberately NO per-role MFA check. ADR-081 §1.1 once refused a role
// whose `required_mfa_methods` a service account could not satisfy; ADR-101
// retired that field from the wire (zero realms ever configured one), so there
// is no role-level floor left to be unsatisfiable. The per-realm and per-tenant
// MFA policies are untouched and still apply to humans.
func IsRoleAssignableTo(role *RoleObject, kind string) bool {
	if role == nil {
		return false
	}
	if kind != PrincipalHuman && kind != PrincipalService {
		return false
	}
	if _, blocked := systemUnassignable[role.Name]; blocked {
		return false
	}
	if role.Disabled {
		return false
	}
	if len(role.AssignableTo) > 0 && !containsString(role.AssignableTo, kind) {
		return false
	}
	if kind != PrincipalService {
		return true
	}
	if role.IsSystem {
		return true
	}
	for _, p := range role.Permissions {
		if _, humanOnly := humanOnlyPermissions[p]; humanOnly {
			return false
		}
	}
	return true
}

// RolesAssignableTo filters a catalog page down to the roles `kind` may hold,
// preserving the server's order. Always returns a non-nil slice so a caller can
// range over it and report "no roles available" without a nil check.
func RolesAssignableTo(roles []RoleObject, kind string) []RoleObject {
	out := make([]RoleObject, 0, len(roles))
	for i := range roles {
		if IsRoleAssignableTo(&roles[i], kind) {
			out = append(out, roles[i])
		}
	}
	return out
}

func containsString(hay []string, needle string) bool {
	for _, h := range hay {
		if h == needle {
			return true
		}
	}
	return false
}
