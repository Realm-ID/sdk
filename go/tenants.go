package realmid

import (
	"context"
	"net/url"
	"strconv"
)

// Tenant is one entry returned from realm.Tenants.* (SPEC §6.1).
type Tenant struct {
	ID          string         `json:"id"`
	DisplayName string         `json:"display_name,omitempty"`
	OwnerUserID string         `json:"owner_user_id,omitempty"`
	Config      map[string]any `json:"config,omitempty"`
	CreatedAt   string         `json:"created_at,omitempty"`
	UpdatedAt   string         `json:"updated_at,omitempty"`
}

// TenantCreate is the create payload (SPEC §6.1).
type TenantCreate struct {
	DisplayName    string   `json:"display_name"`
	AllowedDomains []string `json:"allowed_domains,omitempty"`
	OpenSignup     bool     `json:"open_signup,omitempty"`
}

// UpdateUserRoleResult is the response shape returned by Tenants.UpdateUserRole.
type UpdateUserRoleResult struct {
	ID        string `json:"id"`
	Role      string `json:"role"`
	TenantID  string `json:"tenant_id"`
	UpdatedAt int64  `json:"updated_at"`
}

// TenantPatch patches mutable tenant fields.
type TenantPatch struct {
	DisplayName string `json:"display_name,omitempty"`
}

// Invitation represents a pending tenant invite.
type Invitation struct {
	ID       string `json:"id"`
	TenantID string `json:"tenant_id"`
	Email    string `json:"email"`
	Role     string `json:"role,omitempty"`
	Status   string `json:"status,omitempty"`
}

// InvitationCreate is the create payload for /tenants/{id}/invitations.
type InvitationCreate struct {
	Email string `json:"email"`
	Role  string `json:"role,omitempty"`
}

// User is one entry in realm.Tenants.Users.* (SPEC §6.3).
type User struct {
	ID          string `json:"id"`
	Email       string `json:"email,omitempty"`
	DisplayName string `json:"display_name,omitempty"`
	Status      string `json:"status,omitempty"`
	MFAEnabled  bool   `json:"mfa_enabled,omitempty"`
	Role        string `json:"role,omitempty"`
}

// UserStatus is the discrete status field on a user record.
type UserStatus string

const (
	UserStatusActive      UserStatus = "active"
	UserStatusSuspended   UserStatus = "suspended"
	UserStatusDeactivated UserStatus = "deactivated"
)

// MFAEnrollResult is the response from EnrollMFA.
type MFAEnrollResult struct {
	Secret      string   `json:"secret,omitempty"`
	OtpauthURI  string   `json:"otpauth_uri,omitempty"`
	BackupCodes []string `json:"backup_codes,omitempty"`
}

// TenantsClient is realm.Tenants.
type TenantsClient struct {
	realm       *Realm
	Invitations *InvitationsClient
	Users       *UsersClient
}

func newTenantsClient(r *Realm) *TenantsClient {
	return &TenantsClient{
		realm:       r,
		Invitations: &InvitationsClient{realm: r},
		Users:       &UsersClient{realm: r},
	}
}

// List paginates tenants (SPEC §6.1).
func (c *TenantsClient) List(ctx context.Context) *Paginated[Tenant] {
	return newPaginated(func(ctx context.Context, opts PageOpts) (*Page[Tenant], error) {
		return fetchPage[Tenant](ctx, c.realm, "/tenants", opts)
	})
}

// Get returns a tenant by id.
func (c *TenantsClient) Get(ctx context.Context, id string) (*Tenant, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var t Tenant
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "GET",
		Path:   "/tenants/" + url.PathEscape(id),
		Bearer: tok,
	}, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

// Create creates a tenant.
func (c *TenantsClient) Create(ctx context.Context, body TenantCreate) (*Tenant, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var t Tenant
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/tenants",
		Bearer: tok,
		Body:   body,
	}, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

// Update patches an existing tenant.
func (c *TenantsClient) Update(ctx context.Context, id string, patch TenantPatch) (*Tenant, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var t Tenant
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "PATCH",
		Path:   "/tenants/" + url.PathEscape(id),
		Bearer: tok,
		Body:   patch,
	}, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

// UpdateConfig patches the per-tenant config blob.
func (c *TenantsClient) UpdateConfig(ctx context.Context, id string, patch map[string]any) (*Tenant, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var t Tenant
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "PATCH",
		Path:   "/tenants/" + url.PathEscape(id) + "/config",
		Bearer: tok,
		Body:   patch,
	}, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

// Delete removes a tenant.
func (c *TenantsClient) Delete(ctx context.Context, id string) error {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return err
	}
	return c.realm.http.do(ctx, requestOptions{
		Method: "DELETE",
		Path:   "/tenants/" + url.PathEscape(id),
		Bearer: tok,
	}, nil)
}

// TransferOwner reassigns tenant ownership.
func (c *TenantsClient) TransferOwner(ctx context.Context, id, newOwnerUserID string) (*Tenant, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var t Tenant
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "PUT",
		Path:   "/tenants/" + url.PathEscape(id) + "/owner",
		Bearer: tok,
		Body:   map[string]string{"owner_user_id": newOwnerUserID},
	}, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

// InvitationsClient is realm.Tenants.Invitations.
type InvitationsClient struct {
	realm *Realm
}

func (c *InvitationsClient) List(ctx context.Context, tenantID string) *Paginated[Invitation] {
	path := "/tenants/" + url.PathEscape(tenantID) + "/invitations"
	return newPaginated(func(ctx context.Context, opts PageOpts) (*Page[Invitation], error) {
		return fetchPage[Invitation](ctx, c.realm, path, opts)
	})
}

func (c *InvitationsClient) Create(ctx context.Context, tenantID string, body InvitationCreate) (*Invitation, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var inv Invitation
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/tenants/" + url.PathEscape(tenantID) + "/invitations",
		Bearer: tok,
		Body:   body,
	}, &inv); err != nil {
		return nil, err
	}
	return &inv, nil
}

func (c *InvitationsClient) Delete(ctx context.Context, tenantID, invitationID string) error {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return err
	}
	return c.realm.http.do(ctx, requestOptions{
		Method: "DELETE",
		Path:   "/tenants/" + url.PathEscape(tenantID) + "/invitations/" + url.PathEscape(invitationID),
		Bearer: tok,
	}, nil)
}

// UsersClient is realm.Tenants.Users.
type UsersClient struct {
	realm *Realm
}

func (c *UsersClient) List(ctx context.Context, tenantID string) *Paginated[User] {
	path := "/tenants/" + url.PathEscape(tenantID) + "/users"
	return newPaginated(func(ctx context.Context, opts PageOpts) (*Page[User], error) {
		return fetchPage[User](ctx, c.realm, path, opts)
	})
}

func (c *UsersClient) Get(ctx context.Context, tenantID, userID string) (*User, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var u User
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "GET",
		Path:   "/tenants/" + url.PathEscape(tenantID) + "/users/" + url.PathEscape(userID),
		Bearer: tok,
	}, &u); err != nil {
		return nil, err
	}
	return &u, nil
}

func (c *UsersClient) UpdateStatus(ctx context.Context, tenantID, userID string, status UserStatus) (*User, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var u User
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "PATCH",
		Path:   "/tenants/" + url.PathEscape(tenantID) + "/users/" + url.PathEscape(userID) + "/status",
		Bearer: tok,
		Body:   map[string]string{"status": string(status)},
	}, &u); err != nil {
		return nil, err
	}
	return &u, nil
}

func (c *UsersClient) EnrollMFA(ctx context.Context, tenantID, userID string) (*MFAEnrollResult, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out MFAEnrollResult
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/tenants/" + url.PathEscape(tenantID) + "/users/" + url.PathEscape(userID) + "/mfa/enroll",
		Bearer: tok,
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *UsersClient) ConfirmMFA(ctx context.Context, tenantID, userID, code string) error {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return err
	}
	return c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/tenants/" + url.PathEscape(tenantID) + "/users/" + url.PathEscape(userID) + "/mfa/confirm",
		Bearer: tok,
		Body:   map[string]string{"code": code},
	}, nil)
}

func (c *UsersClient) ResetMFA(ctx context.Context, tenantID, userID string) error {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return err
	}
	return c.realm.http.do(ctx, requestOptions{
		Method: "DELETE",
		Path:   "/tenants/" + url.PathEscape(tenantID) + "/users/" + url.PathEscape(userID) + "/mfa",
		Bearer: tok,
	}, nil)
}

// fetchPage is the shared list-fetch helper used by all paginated
// management endpoints. It enforces the locked wire shape from SPEC §7
// (rejects any other shape with a server_error RealmError).
func fetchPage[T any](ctx context.Context, r *Realm, path string, opts PageOpts) (*Page[T], error) {
	tok, err := r.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	q := map[string]string{}
	if opts.Cursor != "" {
		q["cursor"] = opts.Cursor
	}
	if opts.Limit > 0 {
		q["limit"] = strconv.Itoa(opts.Limit)
	}
	var env pageEnvelope[T]
	if err := r.http.do(ctx, requestOptions{
		Method: "GET",
		Path:   path,
		Bearer: tok,
		Query:  q,
	}, &env); err != nil {
		return nil, err
	}
	if env.Items == nil {
		// Server returned a non-pageable shape — reject per SPEC §7.
		return nil, &RealmError{Code: ErrCodeServerError, Message: "list endpoint did not return {items, next_cursor}"}
	}
	return &Page[T]{Items: env.Items, NextCursor: env.NextCursor, Total: env.Total}, nil
}
