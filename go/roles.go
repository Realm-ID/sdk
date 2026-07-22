// Package realmid — platform-defined custom roles (ADR-040).
//
// Realms own a `realm_roles` catalog. `RoleOwner` and `RoleMember` are
// the only system roles; everything else is partner-defined per realm.
// Use the named constants for the load-bearing system names; everywhere
// else `Role` is just a string alias so partners can declare their own
// names (e.g. "salesman", "dispatch") and pass them through.
package realmid

import (
	ctxpkg "context"
	"errors"
	"net/url"
	"strconv"
)

// Role is the wire form of a role name. Stays a string alias — see
// ADR-040 decision §3 (no fixed enum).
type Role = string

// System role names. Per ADR-040 §Decision, only `owner` and `member`
// are genuine system roles; the previous `admin` and `viewer` are now
// regular custom roles partners can edit/delete.
const (
	RoleOwner  Role = "owner"
	RoleMember Role = "member"
)

// RoleObject is one realm-defined role, as returned by the
// `/platforms/{id}/roles` endpoints.
type RoleObject struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	DisplayName string   `json:"display_name,omitempty"`
	Permissions []string `json:"permissions"`
	// RequiredMFAMethods is the ADR-075 per-role MFA method set — every holder
	// of this role must satisfy MFA via one of these methods at login. Always an
	// array. Only "totp"/"otp" are accepted server-side. Empty means the role
	// imposes no MFA requirement of its own.
	RequiredMFAMethods []string `json:"required_mfa_methods"`
	// CanInviteRoles is the ADR-076 WP4 invitation scope — the role names a
	// holder of this role may invite new members at. Inert unless the role also
	// holds the `invitations:manage` permission: the invite gate requires both.
	// Always an array.
	CanInviteRoles []string `json:"can_invite_roles"`
	// AssignableTo is the ADR-081 principal-kind constraint — the `users.kind`
	// values ("human" / "service") that may hold this role. Since § Amendment 2
	// the server never stores it empty, so an empty array here means the
	// response came from an issuer older than v0.57.0, where it meant ANY —
	// treat it that way (fail open on read; the server enforces on write).
	AssignableTo []string `json:"assignable_to"`
	// MigratedHolders and MigratedHoldersTo report the ADR-081 §2.5 holder
	// migration. They are set ONLY on the Update response of a patch that
	// narrowed AssignableTo so humans may no longer hold the role: the human
	// holders are reassigned in the same transaction rather than stranded.
	// MigratedHolders is nil on every other response (including a narrowing
	// that moved nobody, which reports 0).
	MigratedHolders   *int   `json:"migrated_holders,omitempty"`
	MigratedHoldersTo string `json:"migrated_holders_to,omitempty"`
	IsSystem          bool   `json:"is_system"`
	// Disabled reports whether the role has been soft-disabled: it stays
	// in the catalog but is hidden and no longer assignable. Toggle with
	// Disable/Enable. Absent on older servers (decodes to false).
	Disabled bool `json:"disabled"`
	// DisabledAt is the unix-seconds timestamp the role was disabled;
	// zero when active.
	DisabledAt int64 `json:"disabled_at,omitempty"`
	CreatedAt  int64 `json:"created_at"`
	UpdatedAt  int64 `json:"updated_at"`
}

// RoleListPage is one page of `/platforms/{id}/roles` in the locked
// SPEC §7 envelope shape.
type RoleListPage struct {
	Items      []RoleObject `json:"items"`
	NextCursor string       `json:"next_cursor,omitempty"`
	Total      *int         `json:"total,omitempty"`
}

// Permission is one grantable permission from the fixed ADR-074 catalog,
// as returned by GET /platforms/{id}/permissions. These gate RI admin-console
// operations for the platform — not the partner's own product RBAC.
type Permission struct {
	Key      string `json:"key"`
	Resource string `json:"resource"`
	Action   string `json:"action"`
	Label    string `json:"label"`
}

// permissionCatalog is the wire envelope for GET …/permissions.
type permissionCatalog struct {
	Permissions []Permission `json:"permissions"`
}

// RoleListOpts are the optional pagination inputs.
type RoleListOpts struct {
	Cursor string
	Limit  int
	// IncludeSystem asks the server to also return system roles it hides
	// by default (currently `platform_api`). `owner`/`member` are always
	// returned. Maps to `?include_system=true`.
	IncludeSystem bool
}

// RoleCreate is the POST body.
type RoleCreate struct {
	Name        string   `json:"name"`
	DisplayName string   `json:"display_name,omitempty"`
	Permissions []string `json:"permissions,omitempty"`
	// RequiredMFAMethods sets the ADR-075 per-role MFA requirement
	// (subset of {"totp","otp"}). Omit/empty for none.
	RequiredMFAMethods []string `json:"required_mfa_methods,omitempty"`
	// CanInviteRoles sets the ADR-076 WP4 invitation scope. Each entry must be
	// a known non-owner role name in the realm. Omit/empty for none.
	CanInviteRoles []string `json:"can_invite_roles,omitempty"`
	// AssignableTo declares which principal kinds may hold the role — any
	// non-empty subset of {"human","service"} (ADR-081). Leaving it nil omits
	// the key, and the server then defaults to BOTH kinds; it is not an error.
	// Note the wire distinction the server draws — an explicit `[]` is a 400
	// `assignable_to_required` — is not reachable from here, because omitempty
	// drops an empty slice. That is deliberate: the only way to hit that error
	// would be to ask for it.
	AssignableTo []string `json:"assignable_to,omitempty"`
}

// RolePatch is the PATCH body. Pointer fields signal "include in
// payload"; nil means "don't touch".
type RolePatch struct {
	DisplayName *string   `json:"display_name,omitempty"`
	Permissions *[]string `json:"permissions,omitempty"`
	// RequiredMFAMethods overwrites the ADR-075 per-role MFA method set when
	// non-nil. Send a pointer to an empty slice to clear it; nil leaves it
	// untouched (PATCH semantics).
	RequiredMFAMethods *[]string `json:"required_mfa_methods,omitempty"`
	// CanInviteRoles overwrites the ADR-076 WP4 invitation scope when non-nil.
	// A pointer to an empty slice clears it; nil leaves it untouched.
	CanInviteRoles *[]string `json:"can_invite_roles,omitempty"`
	// AssignableTo overwrites the ADR-081 principal-kind constraint when
	// non-nil; nil leaves it untouched. Unlike its siblings there is NO clear:
	// a pointer to an empty slice is a 400 `assignable_to_required`, since
	// § Amendment 2 removed "unconstrained" as a storable state — name the
	// kinds instead.
	//
	// Narrowing this so humans may no longer hold the role MIGRATES the role's
	// existing human holders, in the same transaction, to the realm's default
	// invitation role (else `member`). The response then carries
	// MigratedHolders + MigratedHoldersTo.
	AssignableTo *[]string `json:"assignable_to,omitempty"`
}

// RoleDeleteResult is the DELETE acknowledgment.
type RoleDeleteResult struct {
	Status string `json:"status"`
}

// RoleDeleteOpts are the optional inputs to Delete (ADR-074/Phase 3).
type RoleDeleteOpts struct {
	// MigrateTo, when set, reassigns every holder of the deleted role to this
	// target role (server-side, one transaction) instead of failing with
	// ErrRoleInUse. Maps to `?migrate_to=<name>`.
	MigrateTo string
}

// Typed errors mirrored from the server taxonomy. Use errors.Is to
// branch on these.
var (
	ErrRoleNotFound        = errors.New("realmid: role not found")
	ErrRoleExists          = errors.New("realmid: role already exists")
	ErrRoleInUse           = errors.New("realmid: role still attached to users/invitations")
	ErrSystemRoleImmutable = errors.New("realmid: system role is immutable")
)

// RolesClient is realm.Roles.
type RolesClient struct {
	realm *Realm
}

// List returns one page of `/platforms/{id}/roles`. Unlike the typed
// iterators on Tenants etc., this surface returns the raw envelope so
// callers can drive their own paging UI directly.
func (c *RolesClient) List(ctx ctxpkg.Context, opts *RoleListOpts) (*RoleListPage, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	q := map[string]string{}
	if opts != nil {
		if opts.Cursor != "" {
			q["cursor"] = opts.Cursor
		}
		if opts.Limit > 0 {
			q["limit"] = strconv.Itoa(opts.Limit)
		}
		if opts.IncludeSystem {
			q["include_system"] = "true"
		}
	}
	var page RoleListPage
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "GET",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/roles",
		Bearer: tok,
		Query:  q,
	}, &page); err != nil {
		return nil, mapRoleErr(err)
	}
	if page.Items == nil {
		page.Items = []RoleObject{}
	}
	return &page, nil
}

// Create creates a custom role. Returns ErrRoleExists if the name is
// already taken in the realm.
func (c *RolesClient) Create(ctx ctxpkg.Context, body RoleCreate) (*RoleObject, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var r RoleObject
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/roles",
		Bearer: tok,
		Body:   body,
	}, &r); err != nil {
		return nil, mapRoleErr(err)
	}
	return &r, nil
}

// Update patches display_name and/or permissions on an existing role.
// Returns ErrSystemRoleImmutable when called on `owner` or `member`.
func (c *RolesClient) Update(ctx ctxpkg.Context, roleID string, patch RolePatch) (*RoleObject, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var r RoleObject
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "PATCH",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/roles/" + url.PathEscape(roleID),
		Bearer: tok,
		Body:   patch,
	}, &r); err != nil {
		return nil, mapRoleErr(err)
	}
	return &r, nil
}

// Delete removes a custom role. Returns ErrRoleInUse (409) when the
// role is still attached to users/invitations, ErrSystemRoleImmutable
// (400) for `owner`/`member`.
func (c *RolesClient) Delete(ctx ctxpkg.Context, roleID string, opts ...RoleDeleteOpts) (*RoleDeleteResult, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var q map[string]string
	if len(opts) > 0 && opts[0].MigrateTo != "" {
		q = map[string]string{"migrate_to": opts[0].MigrateTo}
	}
	var out RoleDeleteResult
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "DELETE",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/roles/" + url.PathEscape(roleID),
		Bearer: tok,
		Query:  q,
	}, &out); err != nil {
		return nil, mapRoleErr(err)
	}
	if out.Status == "" {
		out.Status = "deleted"
	}
	return &out, nil
}

// Rename rewrites a role's name in `realm_roles`, `users.role`, and
// `invitations.role` in one transaction (server-side).
func (c *RolesClient) Rename(ctx ctxpkg.Context, roleID string, to string) (*RoleObject, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var r RoleObject
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/roles/" + url.PathEscape(roleID) + "/rename",
		Bearer: tok,
		Body:   map[string]string{"to": to},
	}, &r); err != nil {
		return nil, mapRoleErr(err)
	}
	return &r, nil
}

// Disable soft-disables a custom role (POST …/roles/{id}/disable). The
// role stays in the catalog but is hidden and no longer assignable. The
// server rejects disabling a protected role (`owner`/`platform_api`), the
// realm's current default invitation role, or the last remaining active
// role (400 with a role-specific code).
func (c *RolesClient) Disable(ctx ctxpkg.Context, roleID string) (*RoleObject, error) {
	return c.setDisabled(ctx, roleID, true)
}

// Enable re-enables a previously disabled role (POST …/roles/{id}/enable).
func (c *RolesClient) Enable(ctx ctxpkg.Context, roleID string) (*RoleObject, error) {
	return c.setDisabled(ctx, roleID, false)
}

func (c *RolesClient) setDisabled(ctx ctxpkg.Context, roleID string, disabled bool) (*RoleObject, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	action := "enable"
	if disabled {
		action = "disable"
	}
	var r RoleObject
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/roles/" + url.PathEscape(roleID) + "/" + action,
		Bearer: tok,
	}, &r); err != nil {
		return nil, mapRoleErr(err)
	}
	return &r, nil
}

// ListPermissions returns the fixed catalog of grantable permissions
// (ADR-074) from GET /platforms/{id}/permissions. Served live (not a static
// const) so callers can't drift from the server's catalog.
func (c *RolesClient) ListPermissions(ctx ctxpkg.Context) ([]Permission, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out permissionCatalog
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "GET",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/permissions",
		Bearer: tok,
	}, &out); err != nil {
		return nil, mapRoleErr(err)
	}
	if out.Permissions == nil {
		out.Permissions = []Permission{}
	}
	return out.Permissions, nil
}

// mapRoleErr translates server error envelopes to the typed sentinel
// errors. The server's role-specific `code` strings (`role_in_use`,
// `system_role_immutable`, etc.) aren't part of the SDK's canonical
// ErrorCode union, so we look for them in the envelope siblings.
func mapRoleErr(err error) error {
	var re *RealmError
	if !errors.As(err, &re) {
		return err
	}
	switch detailCode(re) {
	case "role_in_use":
		return errors.Join(ErrRoleInUse, re)
	case "role_exists", "role_already_exists":
		return errors.Join(ErrRoleExists, re)
	case "system_role_immutable":
		return errors.Join(ErrSystemRoleImmutable, re)
	case "unknown_role", "role_not_found":
		return errors.Join(ErrRoleNotFound, re)
	}
	if re.Code == ErrCodeNotFound {
		return errors.Join(ErrRoleNotFound, re)
	}
	if re.Code == ErrCodeConflict {
		return errors.Join(ErrRoleInUse, re)
	}
	return re
}

// detailCode pulls a non-canonical `code` out of an error envelope's
// siblings.
func detailCode(re *RealmError) string {
	if re == nil || re.Details == nil {
		return ""
	}
	if v, ok := re.Details["code"].(string); ok {
		return v
	}
	if env, ok := re.Details["error"].(map[string]any); ok {
		if v, ok := env["code"].(string); ok {
			return v
		}
	}
	return ""
}
