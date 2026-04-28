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
