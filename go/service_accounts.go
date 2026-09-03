package realmid

import (
	ctxpkg "context"
	"errors"
	"net/url"
)

// Service-account error sentinels. Callers branch with errors.Is.
var (
	// ErrServiceAccountHandleTaken is returned when a create/reset-handle
	// collides with a handle already in use in the tenant (409 handle_taken).
	ErrServiceAccountHandleTaken = errors.New("realmid: service-account handle already in use")
	// ErrServiceAccountInvalidRole is returned when the requested role is
	// owner or platform_api (400 invalid_role).
	ErrServiceAccountInvalidRole = errors.New("realmid: service-account role may not be owner or platform_api")
	// ErrServiceAccountNotFound is returned when the account id doesn't resolve
	// in the tenant.
	ErrServiceAccountNotFound = errors.New("realmid: service account not found")
)

func mapServiceAccountErr(err error) error {
	var re *RealmError
	if !errors.As(err, &re) {
		return err
	}
	switch specificCode(re) {
	case "handle_taken":
		return errors.Join(ErrServiceAccountHandleTaken, re)
	case "invalid_role":
		return errors.Join(ErrServiceAccountInvalidRole, re)
	case "service_account_not_found", "user_not_found", "not_service":
		return errors.Join(ErrServiceAccountNotFound, re)
	}
	if re.Code == ErrCodeConflict {
		return errors.Join(ErrServiceAccountHandleTaken, re)
	}
	if re.Code == ErrCodeNotFound {
		return errors.Join(ErrServiceAccountNotFound, re)
	}
	return re
}

// ServiceAccountsClient is realm.ServiceAccounts — the owner/admin surface for
// kind=service accounts (ADR-071 §2/§10). A service account is a first-class
// non-human identity that logs in via a view_bff OTP (never a human provider).
//
// Calls authenticate with the realm's platform token (the realm's own M2M
// admin identity); the issuer gates each call with requireServiceAccountManage
// (owner OR admin of the tenant, or the realm's own M2M token).
type ServiceAccountsClient struct {
	realm *Realm
}

// ServiceAccount is one kind=service account (issuer serviceAccountDTO).
type ServiceAccount struct {
	ID          string `json:"id"`
	Handle      string `json:"handle"`
	Role        string `json:"role"`
	Status      string `json:"status"`
	Kind        string `json:"kind"`
	DisplayName string `json:"display_name,omitempty"`
	CreatedAt   string `json:"created_at,omitempty"`
}

// ServiceAccountCreate is the POST /tenants/{id}/service-accounts body.
type ServiceAccountCreate struct {
	// Handle is the email-shaped login handle (must contain `@`), unique in the
	// tenant. ErrServiceAccountHandleTaken (409) on collision.
	Handle string `json:"handle"`
	// Role is the tenant role; must not be owner or platform_api. Defaults to
	// member when empty.
	Role string `json:"role,omitempty"`
	// DisplayName is optional; defaults to the handle.
	DisplayName string `json:"display_name,omitempty"`
}

// ServiceAccountList is the GET list envelope.
//
// Deprecated: superseded by Page[ServiceAccount], which also carries
// next_cursor/has_more/total. Kept only so an existing type reference still
// compiles; ServiceAccountsClient.List no longer returns it.
type ServiceAccountList struct {
	Items []ServiceAccount `json:"items"`
}

func (c *ServiceAccountsClient) base(tenantID string) string {
	return "/tenants/" + url.PathEscape(tenantID) + "/service-accounts"
}

// Create provisions a new service account in a tenant.
func (c *ServiceAccountsClient) Create(ctx ctxpkg.Context, tenantID string, body ServiceAccountCreate) (*ServiceAccount, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out ServiceAccount
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST", Path: c.base(tenantID), Bearer: tok, Body: body,
	}, &out); err != nil {
		return nil, mapServiceAccountErr(err)
	}
	return &out, nil
}

// List paginates a tenant's service accounts.
//
// It returns a pager, NOT a slice — the endpoint is paginated server-side, so a
// slice would silently be page one. Read Page(...).HasMore to detect
// truncation, or range over All to walk every page.
//
//	for sa, err := range realm.ServiceAccounts.List(ctx, tenantID).All(ctx) { ... }
func (c *ServiceAccountsClient) List(ctx ctxpkg.Context, tenantID string) *Paginated[ServiceAccount] {
	return newPaginated(func(ctx ctxpkg.Context, opts PageOpts) (*Page[ServiceAccount], error) {
		pg, err := fetchPage[ServiceAccount](ctx, c.realm, c.base(tenantID), opts)
		if err != nil {
			return nil, mapServiceAccountErr(err)
		}
		return pg, nil
	})
}

// Get returns one service account by id.
func (c *ServiceAccountsClient) Get(ctx ctxpkg.Context, tenantID, id string) (*ServiceAccount, error) {
	return c.get(ctx, tenantID, id)
}

func (c *ServiceAccountsClient) get(ctx ctxpkg.Context, tenantID, id string) (*ServiceAccount, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out ServiceAccount
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "GET", Path: c.base(tenantID) + "/" + url.PathEscape(id), Bearer: tok,
	}, &out); err != nil {
		return nil, mapServiceAccountErr(err)
	}
	return &out, nil
}

// ResetHandle changes a service account's login handle (unique-in-tenant;
// ErrServiceAccountHandleTaken on collision).
func (c *ServiceAccountsClient) ResetHandle(ctx ctxpkg.Context, tenantID, id, handle string) (*ServiceAccount, error) {
	return c.action(ctx, tenantID, id, "reset-handle", map[string]any{"handle": handle})
}

// Suspend suspends a service account and drops its live sessions.
func (c *ServiceAccountsClient) Suspend(ctx ctxpkg.Context, tenantID, id string) (*ServiceAccount, error) {
	return c.action(ctx, tenantID, id, "suspend", nil)
}

// Unsuspend restores a suspended service account.
func (c *ServiceAccountsClient) Unsuspend(ctx ctxpkg.Context, tenantID, id string) (*ServiceAccount, error) {
	return c.action(ctx, tenantID, id, "unsuspend", nil)
}

// Deactivate soft-deletes a service account (status=deactivated) and revokes
// its sessions.
func (c *ServiceAccountsClient) Deactivate(ctx ctxpkg.Context, tenantID, id string) (*ServiceAccount, error) {
	return c.action(ctx, tenantID, id, "deactivate", nil)
}

// RevokeResult is the POST …/revoke response.
type RevokeResult struct {
	Status          string `json:"status"`
	RevokedSessions int    `json:"revoked_sessions"`
}

// Revoke drops all of a service account's live sessions without changing its
// status (the account can log in again).
func (c *ServiceAccountsClient) Revoke(ctx ctxpkg.Context, tenantID, id string) (*RevokeResult, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out RevokeResult
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST", Path: c.base(tenantID) + "/" + url.PathEscape(id) + "/revoke", Bearer: tok,
	}, &out); err != nil {
		return nil, mapServiceAccountErr(err)
	}
	return &out, nil
}

func (c *ServiceAccountsClient) action(ctx ctxpkg.Context, tenantID, id, verb string, body any) (*ServiceAccount, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out ServiceAccount
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST", Path: c.base(tenantID) + "/" + url.PathEscape(id) + "/" + verb, Bearer: tok, Body: body,
	}, &out); err != nil {
		return nil, mapServiceAccountErr(err)
	}
	return &out, nil
}
