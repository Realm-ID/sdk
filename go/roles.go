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
	Name        string   `json:"name"`
	DisplayName string   `json:"display_name,omitempty"`
	Permissions []string `json:"permissions"`
	IsSystem    bool     `json:"is_system"`
	CreatedAt   int64    `json:"created_at"`
	UpdatedAt   int64    `json:"updated_at"`
}

// RoleListPage is one page of `/platforms/{id}/roles` in the locked
// SPEC §7 envelope shape.
type RoleListPage struct {
	Items      []RoleObject `json:"items"`
	NextCursor string       `json:"next_cursor,omitempty"`
	Total      *int         `json:"total,omitempty"`
}

// RoleListOpts are the optional pagination inputs.
type RoleListOpts struct {
	Cursor string
	Limit  int
}

// RoleCreate is the POST body.
type RoleCreate struct {
	Name        string   `json:"name"`
	DisplayName string   `json:"display_name,omitempty"`
	Permissions []string `json:"permissions,omitempty"`
}

// RolePatch is the PATCH body. Pointer fields signal "include in
// payload"; nil means "don't touch".
type RolePatch struct {
	DisplayName *string   `json:"display_name,omitempty"`
	Permissions *[]string `json:"permissions,omitempty"`
}

// RoleDeleteResult is the DELETE acknowledgment.
type RoleDeleteResult struct {
	Status string `json:"status"`
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
func (c *RolesClient) Update(ctx ctxpkg.Context, name string, patch RolePatch) (*RoleObject, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var r RoleObject
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "PATCH",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/roles/" + url.PathEscape(name),
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
func (c *RolesClient) Delete(ctx ctxpkg.Context, name string) (*RoleDeleteResult, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out RoleDeleteResult
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "DELETE",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/roles/" + url.PathEscape(name),
		Bearer: tok,
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
func (c *RolesClient) Rename(ctx ctxpkg.Context, name string, to string) (*RoleObject, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var r RoleObject
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/roles/" + url.PathEscape(name) + "/rename",
		Bearer: tok,
		Body:   map[string]string{"to": to},
	}, &r); err != nil {
		return nil, mapRoleErr(err)
	}
	return &r, nil
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
