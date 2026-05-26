package realmid

import (
	ctxpkg "context"
	"net/url"
)

// UpdateUserRole sets a user's role within a tenant. The role name must
// exist in the realm's role catalog (see RolesClient.Create). Setting
// role=owner is rejected — use TransferOwner for the explicit handover.
// Demoting the last owner returns RealmError(last_owner).
//
// Wraps PATCH /tenants/{id}/users/{uid}/role. Test coverage:
// TestTenants_UpdateUserRole.
func (c *TenantsClient) UpdateUserRole(ctx ctxpkg.Context, tenantID, userID, role string) (*UpdateUserRoleResult, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out UpdateUserRoleResult
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "PATCH",
		Path:   "/tenants/" + url.PathEscape(tenantID) + "/users/" + url.PathEscape(userID) + "/role",
		Bearer: tok,
		Body:   map[string]string{"role": role},
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateContactInput is the body for Tenants.UpdateUserContact. At
// least one of Email/Phone must be set (SPEC §6.3, v0.11.0).
type UpdateContactInput struct {
	Email string `json:"email,omitempty"`
	Phone string `json:"phone,omitempty"`
}

// UpdateUserContact changes a user's email and/or phone. It soft-releases
// the previous contact of that kind and issues a fresh unverified
// user_contacts row; the recycled slot is held for 30 days. A collision
// with another active member's identifier returns
// RealmError(identifier_collision) (409). Returns the updated User.
//
// Wraps PATCH /tenants/{id}/users/{uid}.
func (c *TenantsClient) UpdateUserContact(ctx ctxpkg.Context, tenantID, userID string, body UpdateContactInput) (*User, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var u User
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "PATCH",
		Path:   "/tenants/" + url.PathEscape(tenantID) + "/users/" + url.PathEscape(userID),
		Bearer: tok,
		Body:   body,
	}, &u); err != nil {
		return nil, err
	}
	return &u, nil
}
