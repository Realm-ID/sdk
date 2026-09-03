package realmid

import (
	"context"
	ctxpkg "context"
	"net/url"
	"strconv"
)

// Avoid an unused-import error if a later cleanup removes the only
// ctxpkg-typed signature; see sdk/CLAUDE.md "Go SDK + GoFr hook quirk".
var _ = ctxpkg.Background

// Tenant is one entry returned from realm.Tenants.* (SPEC §6.1).
type Tenant struct {
	ID          string         `json:"id"`
	DisplayName string         `json:"display_name,omitempty"`
	OwnerUserID string         `json:"owner_user_id,omitempty"`
	Config      map[string]any `json:"config,omitempty"`
	// CreatedAt / UpdatedAt are unix seconds — the issuer serializes tenant
	// timestamps as JSON numbers (matching UpdateUserRoleResult.UpdatedAt
	// below). Mistyped as string through go/v0.21.0; fixed in v0.22.0.
	CreatedAt int64 `json:"created_at,omitempty"`
	UpdatedAt int64 `json:"updated_at,omitempty"`
}

// SignupMode is the per-tenant signup policy (SPEC §6.1, ADR-045).
//
// `closed` (default) is invitation-only; `allowlist` auto-provisions
// users whose verified email domain has an ACTIVE, proven domain grant
// for the tenant (ADR-094); `open` auto-provisions every authenticated
// user and is reserved for the base admin tenant — partner tenants
// cannot set this mode.
//
// A tenant in `allowlist` with no active grant matches nobody. That is a
// legal state, not an error: a grant can be revoked or fail periodic
// re-verification with no write to the tenant at all.
type SignupMode string

const (
	SignupModeClosed    SignupMode = "closed"
	SignupModeAllowlist SignupMode = "allowlist"
	SignupModeOpen      SignupMode = "open"
)

// TenantOwner seats a tenant's owner inline at create (ADR-073 Amendment
// C.2). At least one of Email/Phone is required. There is deliberately no
// role: the owner is provisioned with the dormant `member` role (ADR-076 —
// ownership is the owner_user_id pointer, not a role name), and the owner's
// real app-role, if any, arrives via the roster import that reuses UserID.
type TenantOwner struct {
	// UserID is an optional bring-your-own owner id; absent ⇒ minted.
	UserID string `json:"user_id,omitempty"`
	Email  string `json:"email,omitempty"`
	// Phone is an E.164 number (leading '+').
	Phone       string `json:"phone,omitempty"`
	DisplayName string `json:"display_name,omitempty"`
	// Provider, with ProviderUID, writes the owner's exact first-SSO binding
	// ("google" | "microsoft" | "apple" | "facebook" | "firebase").
	Provider    string `json:"provider,omitempty"`
	ProviderUID string `json:"provider_uid,omitempty"`
}

// TenantCreate is the create payload (SPEC §6.1, ADR-073 Amendment C).
type TenantCreate struct {
	// ID is an optional caller-supplied tenant UUID (ADR-073 C.1). Absent ⇒
	// the server mints a UUIDv7. Present + already exists in this realm ⇒ the
	// call reconciles idempotently; present + exists in another realm ⇒
	// `cross_realm_tenant_id`.
	ID          string     `json:"id,omitempty"`
	DisplayName string     `json:"display_name"`
	SignupMode  SignupMode `json:"signup_mode,omitempty"`
	// CreatedAt is an optional RFC3339 creation timestamp (ADR-073 C.4);
	// absent ⇒ server time. Ignored on reconcile.
	CreatedAt string `json:"created_at,omitempty"`
	// Owner seats the org's owner in the same transaction and is REQUIRED when
	// creating a new tenant (server returns `owner_required` otherwise). It may
	// be omitted only on a pure reconcile of an already-owned tenant.
	Owner *TenantOwner `json:"owner,omitempty"`
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

// Invitation represents a pending tenant invite. ID is the stable user
// id allocated up front; Identifier is the invited email or E.164 phone
// (SPEC §6.2, v0.11.0). ExpiresAt is a unix-seconds timestamp.
type Invitation struct {
	ID         string `json:"id"`
	Identifier string `json:"identifier"`
	Role       string `json:"role,omitempty"`
	Status     string `json:"status,omitempty"`
	ExpiresAt  int64  `json:"expires_at,omitempty"`
}

// InvitationCreate is the create payload for /tenants/{id}/invitations.
// Identifier is an email or an E.164 phone (SPEC §6.2, v0.11.0).
type InvitationCreate struct {
	Identifier string `json:"identifier"`
	Role       string `json:"role,omitempty"`
}

// User is one entry in realm.Tenants.Users.* (SPEC §6.3).
type User struct {
	ID          string `json:"id"`
	Email       string `json:"email,omitempty"`
	Phone       string `json:"phone,omitempty"`
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
	realm                *Realm
	Invitations          *InvitationsClient
	Users                *UsersClient
	DriftReviews         *DriftReviewsClient
	ContactVerifications *ContactVerificationsClient
}

func newTenantsClient(r *Realm) *TenantsClient {
	return &TenantsClient{
		realm:                r,
		Invitations:          &InvitationsClient{realm: r},
		Users:                &UsersClient{realm: r},
		DriftReviews:         &DriftReviewsClient{realm: r},
		ContactVerifications: &ContactVerificationsClient{realm: r},
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

// TenantDomainClaim is the response from Tenants.ClaimDomain. Exactly
// one of (DNSRecordName/DNSRecordValue) and (FilePath/FileContent) is
// populated, determined by the verification method.
type TenantDomainClaim struct {
	Domain         string `json:"domain"`
	Status         string `json:"status"`
	Method         string `json:"method"`
	DNSRecordName  string `json:"dns_record_name,omitempty"`
	DNSRecordValue string `json:"dns_record_value,omitempty"`
	FilePath       string `json:"file_path,omitempty"`
	FileContent    string `json:"file_content,omitempty"`
}

// TenantDomainClaimRequest parameterises Tenants.ClaimDomain. Method
// is optional (defaults to "dns_txt"); accepted values are "dns_txt"
// and "html_file".
type TenantDomainClaimRequest struct {
	PlatformID string
	TenantID   string
	Domain     string
	Method     string // "dns_txt" (default) | "html_file"
}

// ClaimDomain initiates a tenant-owned domain claim. The DV row is
// owner-scoped to the tenant: any platform admin can complete a
// claim another admin started, and the row survives the claimer's
// user being removed. Re-claiming with the same method is idempotent.
func (c *TenantsClient) ClaimDomain(ctx ctxpkg.Context, req TenantDomainClaimRequest) (*TenantDomainClaim, error) {
	if req.PlatformID == "" || req.TenantID == "" || req.Domain == "" {
		return nil, &RealmError{Code: ErrCodeBadRequest, Message: "ClaimDomain: PlatformID, TenantID, Domain required"}
	}
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	body := map[string]string{"domain": req.Domain}
	if req.Method != "" {
		body["method"] = req.Method
	}
	var resp TenantDomainClaim
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/platforms/" + url.PathEscape(req.PlatformID) + "/tenants/" + url.PathEscape(req.TenantID) + "/domains",
		Bearer: tok,
		Body:   body,
	}, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// VerifyDomain drives the verification check on the tenant's pending
// DV row and (on success) inserts the domain_mappings binding in the
// same call. Method is read off the persisted row, so callers don't
// pass it again here.
func (c *TenantsClient) VerifyDomain(ctx ctxpkg.Context, platformID, tenantID, domain string) (*DomainVerifyResult, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var resp DomainVerifyResult
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/platforms/" + url.PathEscape(platformID) + "/tenants/" + url.PathEscape(tenantID) + "/domains/" + url.PathEscape(domain) + "/verify",
		Bearer: tok,
	}, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// TransferOwnerOptions carries the optional ADR-076 direct-transfer knobs
// for TransferOwner. The zero value is a plain hand-over.
type TransferOwnerOptions struct {
	// OutgoingOwnerRole is the role the outgoing owner is demoted to after
	// the transfer. Empty defers to the server default (admin). Ignored
	// when LeaveEntirely is set.
	OutgoingOwnerRole string
	// LeaveEntirely removes the outgoing owner from the tenant entirely
	// instead of demoting them.
	LeaveEntirely bool
}

// TransferOwner reassigns tenant ownership to newOwnerUserID — the ADR-076
// direct owner-pointer op (PUT /tenants/{id}/owner). The recipient must be
// an active member of the tenant. opts is optional: pass nil for a plain
// hand-over (outgoing owner demoted to the server default), or set
// OutgoingOwnerRole / LeaveEntirely to control the outgoing owner's fate.
func (c *TenantsClient) TransferOwner(ctx context.Context, id, newOwnerUserID string, opts *TransferOwnerOptions) (*Tenant, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	body := map[string]any{"owner_user_id": newOwnerUserID}
	if opts != nil {
		if opts.OutgoingOwnerRole != "" {
			body["outgoing_owner_role"] = opts.OutgoingOwnerRole
		}
		if opts.LeaveEntirely {
			body["leave_entirely"] = true
		}
	}
	var t Tenant
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "PUT",
		Path:   "/tenants/" + url.PathEscape(id) + "/owner",
		Bearer: tok,
		Body:   body,
	}, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

// InvitationsClient is realm.Tenants.Invitations.
type InvitationsClient struct {
	realm *Realm
}

// InvitationListOpts filters InvitationsClient.List (SPEC §6.2). Status is
// optional (pending|accepted|revoked|expired); empty omits the filter.
type InvitationListOpts struct {
	Status string
}

func (c *InvitationsClient) List(ctx context.Context, tenantID string, opts *InvitationListOpts) *Paginated[Invitation] {
	o := InvitationListOpts{}
	if opts != nil {
		o = *opts
	}
	path := "/tenants/" + url.PathEscape(tenantID) + "/invitations"
	return newPaginated(func(ctx context.Context, po PageOpts) (*Page[Invitation], error) {
		extra := map[string]string{}
		if o.Status != "" {
			extra["status"] = o.Status
		}
		return fetchFilteredPage[Invitation](ctx, c.realm, path, po, extra)
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

// UserListOpts filters UsersClient.List (SPEC §6.3). All fields are
// optional; empty fields are omitted from the query. Invalid Role/Status
// values are rejected server-side with 400 invalid_role / invalid_status.
type UserListOpts struct {
	Role   string // exact match: owner|admin|member|viewer
	Status string // exact match: active|suspended|invited|deactivated
	Q      string // case-insensitive substring match on email
}

func (c *UsersClient) List(ctx context.Context, tenantID string, opts *UserListOpts) *Paginated[User] {
	o := UserListOpts{}
	if opts != nil {
		o = *opts
	}
	path := "/tenants/" + url.PathEscape(tenantID) + "/users"
	return newPaginated(func(ctx context.Context, po PageOpts) (*Page[User], error) {
		extra := map[string]string{}
		if o.Role != "" {
			extra["role"] = o.Role
		}
		if o.Status != "" {
			extra["status"] = o.Status
		}
		if o.Q != "" {
			extra["q"] = o.Q
		}
		return fetchFilteredPage[User](ctx, c.realm, path, po, extra)
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
	return fetchFilteredPage[T](ctx, r, path, opts, nil)
}

// fetchFilteredPage is fetchPage with an optional set of extra query
// parameters (e.g. role/status/q filters) merged alongside cursor/limit.
func fetchFilteredPage[T any](ctx context.Context, r *Realm, path string, opts PageOpts, extra map[string]string) (*Page[T], error) {
	tok, err := r.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	q := map[string]string{}
	for k, v := range extra {
		if v != "" {
			q[k] = v
		}
	}
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
	p := env.page()
	return &p, nil
}
