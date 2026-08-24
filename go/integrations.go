// Package realmid — cross-realm integrations (ADR-082 / ADR-083).
//
// A SOURCE platform publishes an integration; a TARGET org installs it,
// admitting a kind=service principal into the org that holds a chosen
// service-typed role; the source platform then MINTS short-lived target-realm
// access tokens against the installation. GitHub-App-shaped: register once,
// install per org. RI hosts no consent screen — this surface IS the consent
// surface (ADR-083 §5).
//
// The SDK is per-realm: register/mint run on the SOURCE realm's client, and
// install/uninstall run on the TARGET realm's client.
package realmid

import (
	ctxpkg "context"
	"errors"
	"net/url"
	"strconv"
)

// Integration is a source platform's published declaration.
type Integration struct {
	ID          string `json:"id"`
	RealmID     string `json:"realm_id"`
	Slug        string `json:"slug"`
	DisplayName string `json:"display_name"`
	Description string `json:"description"`
	HomepageURL string `json:"homepage_url"`
	// Listed opts into a future discovery directory (ADR-083 §6.1); the listing
	// API is deferred, so today it is metadata only.
	Listed    bool   `json:"listed"`
	Disabled  bool   `json:"disabled"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

// Installation is the target org's view of one inbound edge — who can act in
// the org, as what. Returned by ListInstallations (ADR-083 §4.5).
type Installation struct {
	ID                     string  `json:"id"`
	IntegrationID          string  `json:"integration_id"`
	SourceRealmID          string  `json:"source_realm_id"`
	IntegrationSlug        string  `json:"integration_slug"`
	IntegrationDisplayName string  `json:"integration_display_name"`
	RoleID                 string  `json:"role_id"`
	RoleName               string  `json:"role_name"`
	PrincipalUserID        string  `json:"principal_user_id"`
	ApprovedByUserID       *string `json:"approved_by_user_id"`
	ApprovedAt             string  `json:"approved_at"`
	LastUsedAt             *string `json:"last_used_at"`
	MintCount              int64   `json:"mint_count"`
}

// IntegrationCreate is the register body.
type IntegrationCreate struct {
	Slug        string `json:"slug"`
	DisplayName string `json:"display_name"`
	Description string `json:"description,omitempty"`
	HomepageURL string `json:"homepage_url,omitempty"`
	Listed      bool   `json:"listed,omitempty"`
}

// IntegrationPatch is the update body. Pointer fields signal "include";
// nil means "don't touch".
type IntegrationPatch struct {
	DisplayName *string `json:"display_name,omitempty"`
	Description *string `json:"description,omitempty"`
	HomepageURL *string `json:"homepage_url,omitempty"`
	Listed      *bool   `json:"listed,omitempty"`
}

// InstallRequest is the install body. RoleID MUST name a role whose
// assignable_to is exactly ["service"] (ADR-082 §7.1).
type InstallRequest struct {
	IntegrationID string `json:"integration_id"`
	RoleID        string `json:"role_id"`
}

// InstallResult is the install acknowledgment.
type InstallResult struct {
	ID              string `json:"id"`
	IntegrationID   string `json:"integration_id"`
	RoleID          string `json:"role_id"`
	RoleName        string `json:"role_name"`
	PrincipalUserID string `json:"principal_user_id"`
	Status          string `json:"status"`
}

// IntegrationMintRequest is the input to MintToken. APIKey is the SOURCE platform's raw
// platform_api key (never a user/session token). SourceOrgID is required and
// stamped into the token + target-org audit, but is caller-asserted (§7.6).
type IntegrationMintRequest struct {
	APIKey         string
	InstallationID string
	SourceOrgID    string
}

// IntegrationMintResult is the brokered token. There is NO refresh token: the token
// cannot be renewed, so re-mint when it nears expiry. ExpiresIn is a fixed
// 600 seconds (ADR-083 §4.3).
type IntegrationMintResult struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   int64  `json:"expires_in"`
	TenantID    string `json:"tenant_id"`
	Role        string `json:"role"`
}

// IntegrationListPage / InstallationListPage are one raw page each (SPEC §7).
type IntegrationListPage struct {
	Items      []Integration `json:"items"`
	NextCursor *string       `json:"next_cursor"`
}
type InstallationListPage struct {
	Items      []Installation `json:"items"`
	NextCursor *string        `json:"next_cursor"`
}

// ListOpts are the optional pagination inputs shared by the list surfaces.
type ListOpts struct {
	Cursor string
	Limit  int
}

// Integration error sentinels. Callers branch with errors.Is.
var (
	ErrIntegrationNotFound  = errors.New("realmid: integration not found")
	ErrIntegrationSlugTaken = errors.New("realmid: integration slug already registered in realm")
	ErrAlreadyInstalled     = errors.New("realmid: integration already installed in org")
	ErrRoleNotServiceTyped  = errors.New(`realmid: role is not exactly ["service"]`)
	ErrInstallationNotFound = errors.New("realmid: installation not found")
	ErrInstallationRevoked  = errors.New("realmid: installation has been revoked")
	ErrRoleUnavailable      = errors.New("realmid: the installed role can no longer back an integration")
	ErrKeyClassMismatch     = errors.New("realmid: this grant requires a platform api key")
)

func mapIntegrationErr(err error) error {
	var re *RealmError
	if !errors.As(err, &re) {
		return err
	}
	// See specificCode: a registered code lands in re.Code and never in the
	// siblings, an unregistered one only in the siblings.
	switch specificCode(re) {
	case "integration_not_found":
		return errors.Join(ErrIntegrationNotFound, re)
	case "slug_taken":
		return errors.Join(ErrIntegrationSlugTaken, re)
	case "already_installed":
		return errors.Join(ErrAlreadyInstalled, re)
	case "role_not_service_typed", "role_not_installable":
		return errors.Join(ErrRoleNotServiceTyped, re)
	case "installation_not_found":
		return errors.Join(ErrInstallationNotFound, re)
	case "installation_revoked":
		return errors.Join(ErrInstallationRevoked, re)
	case "role_unavailable":
		return errors.Join(ErrRoleUnavailable, re)
	case "key_class_mismatch":
		return errors.Join(ErrKeyClassMismatch, re)
	}
	return re
}

// IntegrationsClient is realm.Integrations — both sides of the cross-realm
// integration surface plus the mint.
type IntegrationsClient struct {
	realm *Realm
}

func (c *IntegrationsClient) sourceBase() string {
	return "/platforms/" + url.PathEscape(c.realm.realmID) + "/integrations"
}
func (c *IntegrationsClient) targetBase(tenantID string) string {
	return "/tenants/" + url.PathEscape(tenantID) + "/integration-installations"
}

func listQuery(opts *ListOpts) map[string]string {
	q := map[string]string{}
	if opts != nil {
		if opts.Cursor != "" {
			q["cursor"] = opts.Cursor
		}
		if opts.Limit > 0 {
			q["limit"] = strconv.Itoa(opts.Limit)
		}
	}
	return q
}

// ---- source side ----

// Register publishes a new integration in the source realm.
func (c *IntegrationsClient) Register(ctx ctxpkg.Context, body IntegrationCreate) (*Integration, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out Integration
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST", Path: c.sourceBase(), Bearer: tok, Body: body,
	}, &out); err != nil {
		return nil, mapIntegrationErr(err)
	}
	return &out, nil
}

// List returns one page of the source realm's published integrations.
func (c *IntegrationsClient) List(ctx ctxpkg.Context, opts *ListOpts) (*IntegrationListPage, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var page IntegrationListPage
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "GET", Path: c.sourceBase(), Bearer: tok, Query: listQuery(opts),
	}, &page); err != nil {
		return nil, mapIntegrationErr(err)
	}
	if page.Items == nil {
		page.Items = []Integration{}
	}
	return &page, nil
}

// Update patches an integration's display fields / listed flag.
func (c *IntegrationsClient) Update(ctx ctxpkg.Context, id string, patch IntegrationPatch) (*Integration, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out Integration
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "PATCH", Path: c.sourceBase() + "/" + url.PathEscape(id), Bearer: tok, Body: patch,
	}, &out); err != nil {
		return nil, mapIntegrationErr(err)
	}
	return &out, nil
}

// Disable halts every mint (reversible via Enable).
func (c *IntegrationsClient) Disable(ctx ctxpkg.Context, id string) error {
	return c.toggle(ctx, id, "disable")
}

// Enable re-enables a disabled integration.
func (c *IntegrationsClient) Enable(ctx ctxpkg.Context, id string) error {
	return c.toggle(ctx, id, "enable")
}

func (c *IntegrationsClient) toggle(ctx ctxpkg.Context, id, verb string) error {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return err
	}
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST", Path: c.sourceBase() + "/" + url.PathEscape(id) + "/" + verb, Bearer: tok,
	}, nil); err != nil {
		return mapIntegrationErr(err)
	}
	return nil
}

// Remove permanently disables an integration (the source half of two-ended
// revocation). It is NOT a cascade delete — target orgs' inbound history
// survives (ADR-083 §9).
func (c *IntegrationsClient) Remove(ctx ctxpkg.Context, id string) error {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return err
	}
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "DELETE", Path: c.sourceBase() + "/" + url.PathEscape(id), Bearer: tok,
	}, nil); err != nil {
		return mapIntegrationErr(err)
	}
	return nil
}

// ---- target side ----

// Install admits a foreign integration into a target org. The role named by
// body.RoleID MUST be exactly ["service"] (ADR-082 §7.1) — otherwise
// ErrRoleNotServiceTyped.
func (c *IntegrationsClient) Install(ctx ctxpkg.Context, tenantID string, body InstallRequest) (*InstallResult, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out InstallResult
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST", Path: c.targetBase(tenantID), Bearer: tok, Body: body,
	}, &out); err != nil {
		return nil, mapIntegrationErr(err)
	}
	return &out, nil
}

// ListInstallations returns one page of the target org's inbound access. A
// non-zero count after an ownership transfer is foreign access the new owner
// never approved (ADR-082 §7.4) — surface it.
func (c *IntegrationsClient) ListInstallations(ctx ctxpkg.Context, tenantID string, opts *ListOpts) (*InstallationListPage, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var page InstallationListPage
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "GET", Path: c.targetBase(tenantID), Bearer: tok, Query: listQuery(opts),
	}, &page); err != nil {
		return nil, mapIntegrationErr(err)
	}
	if page.Items == nil {
		page.Items = []Installation{}
	}
	return &page, nil
}

// Uninstall revokes an inbound edge (the target half of two-ended revocation).
// Future mints fail; live access tokens are NOT revoked (bounded by the 600 s
// TTL, ADR-083 §4.4).
func (c *IntegrationsClient) Uninstall(ctx ctxpkg.Context, tenantID, installationID string) error {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return err
	}
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "DELETE", Path: c.targetBase(tenantID) + "/" + url.PathEscape(installationID), Bearer: tok,
	}, nil); err != nil {
		return mapIntegrationErr(err)
	}
	return nil
}

// ---- mint ----

// MintToken mints a brokered target-realm access token against an installation,
// authenticated by the SOURCE platform's raw platform_api key (NOT a
// user/session token). It returns an access token only — no refresh — so
// re-mint as expiry nears. This is deliberately not wired into a token manager
// (§6.14): the token cannot refresh.
func (c *IntegrationsClient) MintToken(ctx ctxpkg.Context, req IntegrationMintRequest) (*IntegrationMintResult, error) {
	var out IntegrationMintResult
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/auth/login",
		// No Bearer — the raw api_key in the body IS the credential.
		Body: map[string]any{
			"grant_type":      "integration_installation",
			"api_key":         req.APIKey,
			"installation_id": req.InstallationID,
			"source_org_id":   req.SourceOrgID,
		},
	}, &out); err != nil {
		return nil, mapIntegrationErr(err)
	}
	return &out, nil
}
