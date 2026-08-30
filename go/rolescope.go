package realmid

import "sort"

// ---- ADR-097 / ADR-100 D9: the ROLE -> SCOPE map ----
//
// ScopePolicy (scope.go) is the route -> scope half: given a token, may this
// request proceed. This file is the other half: given the roles a user holds in
// YOUR product, what scopes should their token carry.
//
// Both maps live in the PARTNER'S repo. RealmID stores neither, and that is the
// whole point of ADR-101 — adding a product role is a change in your codebase,
// not a write into someone else's database with an owner-bound credential.
//
// ⚠️ "Role" here means YOUR role, not `realm_roles`. The two are unrelated and
// easy to conflate. `realm_roles` is RealmID's own administrative vocabulary —
// what a user may do TO REALMID (manage members, mint keys, claim domains).
// A scope governs what a user may do inside YOUR product. RealmID never sees
// your roles and never sees your scopes.
//
// # Where the output goes
//
// ScopesFor produces the list you pass as RolePermissions at mint:
//
//	scopes := myRoles.ScopesFor(user.Roles...)
//	resp, err := client.Auth.Login(ctx, realmid.LoginRequest{
//	    ...,
//	    Scope:           scopes, // what to request
//	    RolePermissions: scopes, // what the role actually confers
//	})
//
// Passing the same list to both is the common case and is correct: Scope is the
// request and RolePermissions is the bound. They differ only when you want to
// request LESS than the role confers.
//
// RealmID intersects RolePermissions with any stored user-API-key
// `permissions_cap`, so the minted token carries ONE effective set and your
// gate never has to intersect anything itself.
//
// # Fail-closed, and silently so — deliberately
//
// A role this map does not know contributes NOTHING rather than erroring. A
// user holding an unmapped role gets a token with fewer scopes and is refused
// at the gate; the alternative — failing the login — locks people out of your
// product because of a config gap. Call Validate at startup to catch the gap
// before it costs anyone a scope.

// RoleScopes maps YOUR role names to the scopes each confers.
//
// A plain map, not an interface: it is configuration, it should be readable in
// a diff, and the whole design intent is that it lives in your repo as data.
type RoleScopes map[string][]string

// ScopesFor returns the union of scopes conferred by the given roles, sorted
// and de-duplicated.
//
// Sorted because the result is compared, logged and sent on the wire, and an
// order that depends on map iteration makes two identical grants look
// different. De-duplicated because two roles commonly confer the same scope and
// the wire value should say it once.
//
// Returns nil — not an empty slice — when nothing is conferred, so the caller
// can tell "no scopes" from "I did not ask". Passing nil to RolePermissions
// omits the field, which means "do not narrow"; if you want "narrow to
// nothing", pass an explicit empty slice.
func (m RoleScopes) ScopesFor(roles ...string) []string {
	if len(m) == 0 || len(roles) == 0 {
		return nil
	}
	seen := map[string]struct{}{}
	for _, role := range roles {
		for _, s := range m[role] {
			if s == "" {
				continue
			}
			seen[s] = struct{}{}
		}
	}
	if len(seen) == 0 {
		return nil
	}
	out := make([]string, 0, len(seen))
	for s := range seen {
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

// Roles returns the role names the map knows, sorted. Useful for a startup log
// line and for asserting in your own tests that the map covers every role your
// product can assign.
func (m RoleScopes) Roles() []string {
	out := make([]string, 0, len(m))
	for r := range m {
		out = append(out, r)
	}
	sort.Strings(out)
	return out
}

// Validate reports configuration errors. Call it once at startup — a bad entry
// here costs a user their authority at request time, far from the typo.
//
// Three refusals:
//
//   - an empty role name, which no token can ever match;
//   - a role mapped to no scopes, which is almost always an unfinished entry
//     rather than a deliberate "this role may do nothing" — express that by
//     omitting the role, and say so in a comment;
//   - a scope that is not a legal RFC 6749 §3.3 token, which the issuer will
//     refuse at mint. Catching it here turns a login-time failure into a
//     start-up failure.
func (m RoleScopes) Validate() []error {
	var errs []error
	for _, role := range m.Roles() {
		if role == "" {
			errs = append(errs, &RoleScopeConfigError{Msg: "role name is empty"})
			continue
		}
		scopes := m[role]
		if len(scopes) == 0 {
			errs = append(errs, &RoleScopeConfigError{
				Role: role, Msg: "maps to no scopes; omit the role instead"})
			continue
		}
		for _, s := range scopes {
			if !isRFC6749ScopeToken(s) {
				errs = append(errs, &RoleScopeConfigError{
					Role: role,
					Msg:  "maps to " + quoteScope(s) + ", which is not a legal RFC 6749 scope token"})
			}
		}
	}
	return errs
}

// RoleScopeConfigError is one problem found by RoleScopes.Validate.
//
// A distinct type from ScopeConfigError even though both are configuration
// errors about scopes: they are found in different maps and fixed in different
// places, and an operator reading a boot log needs to know which map to open.
type RoleScopeConfigError struct {
	Role string
	Msg  string
}

func (e *RoleScopeConfigError) Error() string {
	if e.Role == "" {
		return "realmid: role scopes: " + e.Msg
	}
	return "realmid: role scopes: role " + quoteScope(e.Role) + " " + e.Msg
}
