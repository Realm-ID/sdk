// Package realmid — identity-provider config CRUD (admin surface).
//
// This is the realm-admin management client for federated identity
// providers (google / microsoft / facebook / apple). It is distinct
// from Realm.IdentityProviders, which is the public, read-only SPA
// discovery endpoint. The server requires platform_id on every call;
// the SDK injects it as the realm's own id so callers never pass it.
package realmid

import (
	ctxpkg "context"
	"errors"
	"net/url"
)

// IDPConfig is one identity-provider configuration row, as returned by
// the /identity-providers admin endpoints (wire = snake_case).
type IDPConfig struct {
	ID             string   `json:"id"`
	EntityType     string   `json:"entity_type"` // "realm" | "tenant"
	EntityID       string   `json:"entity_id"`
	Provider       string   `json:"provider"`    // "google" | "microsoft" | "facebook" | "apple"
	ClientType     string   `json:"client_type"` // "web" | "ios" | "android" | "desktop" | "other"
	ClientID       string   `json:"client_id"`
	AllowedOrigins []string `json:"allowed_origins"`
	Comments       string   `json:"comments"`
	// Config is the provider's PUBLIC config (never secrets) — e.g. the
	// Firebase web config (apiKey, authDomain, projectId, appId). It is
	// echoed verbatim on public discovery so a browser SDK can bootstrap
	// sign-in. Omitted when empty.
	Config    map[string]string `json:"config,omitempty"`
	Enabled   bool              `json:"enabled"`
	CreatedAt int64             `json:"created_at"`
	UpdatedAt int64             `json:"updated_at"`
}

// IDPConfigListPage is the list envelope for GET /identity-providers.
type IDPConfigListPage struct {
	Items []IDPConfig `json:"items"`
}

// IDPConfigListOpts are the optional filters for List.
type IDPConfigListOpts struct {
	// TenantID scopes the listing to a single tenant within the realm.
	// Empty lists realm-scope (and tenant) providers per server default.
	TenantID string
}

// IDPConfigCreate is the POST body. platform_id is injected by the SDK
// (= realm id) and must not be set here. When TenantID is set the
// provider is scoped to that tenant; otherwise it is realm-scoped.
//
// Validation (server-enforced, passed through): client_type=web REQUIRES
// a non-empty AllowedOrigins; non-web REQUIRES it absent/empty.
type IDPConfigCreate struct {
	TenantID       string
	Provider       string
	ClientType     string
	ClientID       string
	AllowedOrigins []string
	Comments       string
	// Config is the provider's PUBLIC config (never secrets) — e.g. the
	// Firebase web config (apiKey, authDomain, projectId, appId). Echoed
	// verbatim on public discovery. Optional; omit for plain OIDC.
	Config map[string]string
}

// IDPConfigPatch is the PATCH body. All fields are optional (pointer
// semantics — nil means "don't touch"). At least one must be set or the
// server returns empty_patch.
type IDPConfigPatch struct {
	Enabled        *bool
	ClientID       *string
	AllowedOrigins *[]string
	Comments       *string
	// Config, when non-nil, REPLACES the stored provider config map
	// wholesale (not merged). Publishable values only — never secrets.
	Config *map[string]string
}

// IDPConfigDeleteResult is the DELETE acknowledgment.
type IDPConfigDeleteResult struct {
	Status string `json:"status"`
}

// Typed errors mirrored from the server taxonomy. Use errors.Is to
// branch on these.
var (
	ErrIDPExists   = errors.New("realmid: identity provider already exists")
	ErrIDPNotFound = errors.New("realmid: identity provider not found")
)

// IdentityProviderConfigClient is realm.IdentityProviderConfig — the
// admin CRUD surface for federated identity providers. Authz uses the
// realm's platform token, like RolesClient.
type IdentityProviderConfigClient struct {
	realm *Realm
}

// List returns the identity-provider configs for this realm, optionally
// scoped to a tenant. A nil/absent items array normalizes to empty.
func (c *IdentityProviderConfigClient) List(ctx ctxpkg.Context, opts *IDPConfigListOpts) (*IDPConfigListPage, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	q := map[string]string{"platform_id": c.realm.realmID}
	if opts != nil && opts.TenantID != "" {
		q["tenant_id"] = opts.TenantID
	}
	var page IDPConfigListPage
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "GET",
		Path:   "/identity-providers",
		Bearer: tok,
		Query:  q,
	}, &page); err != nil {
		return nil, mapIDPErr(err)
	}
	if page.Items == nil {
		page.Items = []IDPConfig{}
	}
	return &page, nil
}

// Create registers a new identity-provider config. platform_id is
// injected as the realm id. Returns ErrIDPExists (409) when a config for
// the same (entity, provider, client_type) already exists.
func (c *IdentityProviderConfigClient) Create(ctx ctxpkg.Context, body IDPConfigCreate) (*IDPConfig, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	wire := map[string]any{
		"platform_id": c.realm.realmID,
		"provider":    body.Provider,
		"client_type": body.ClientType,
		"client_id":   body.ClientID,
	}
	if body.TenantID != "" {
		wire["tenant_id"] = body.TenantID
	}
	if len(body.AllowedOrigins) > 0 {
		wire["allowed_origins"] = body.AllowedOrigins
	}
	if body.Comments != "" {
		wire["comments"] = body.Comments
	}
	if len(body.Config) > 0 {
		wire["config"] = body.Config
	}
	var out IDPConfig
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/identity-providers",
		Bearer: tok,
		Body:   wire,
	}, &out); err != nil {
		return nil, mapIDPErr(err)
	}
	return &out, nil
}

// Update patches an existing identity-provider config. Only the set
// (non-nil) patch fields are sent. At least one must be set or the
// server returns empty_patch. Returns ErrIDPNotFound (404) for an
// unknown id.
func (c *IdentityProviderConfigClient) Update(ctx ctxpkg.Context, id string, patch IDPConfigPatch) (*IDPConfig, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	wire := map[string]any{}
	if patch.Enabled != nil {
		wire["enabled"] = *patch.Enabled
	}
	if patch.ClientID != nil {
		wire["client_id"] = *patch.ClientID
	}
	if patch.AllowedOrigins != nil {
		wire["allowed_origins"] = *patch.AllowedOrigins
	}
	if patch.Comments != nil {
		wire["comments"] = *patch.Comments
	}
	if patch.Config != nil {
		wire["config"] = *patch.Config
	}
	var out IDPConfig
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "PATCH",
		Path:   "/identity-providers/" + url.PathEscape(id),
		Bearer: tok,
		Body:   wire,
	}, &out); err != nil {
		return nil, mapIDPErr(err)
	}
	return &out, nil
}

// Delete removes an identity-provider config. Returns ErrIDPNotFound
// (404) for an unknown id. The status defaults to "deleted" when the
// server omits it.
func (c *IdentityProviderConfigClient) Delete(ctx ctxpkg.Context, id string) (*IDPConfigDeleteResult, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var res IDPConfigDeleteResult
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "DELETE",
		Path:   "/identity-providers/" + url.PathEscape(id),
		Bearer: tok,
	}, &res); err != nil {
		return nil, mapIDPErr(err)
	}
	if res.Status == "" {
		res.Status = "deleted"
	}
	return &res, nil
}

// mapIDPErr translates server error envelopes to the typed sentinels.
// The provider-specific `code` strings aren't part of the canonical
// ErrorCode union, so we read them from the envelope siblings via
// detailCode (shared with mapRoleErr).
func mapIDPErr(err error) error {
	var re *RealmError
	if !errors.As(err, &re) {
		return err
	}
	switch detailCode(re) {
	case "provider_exists":
		return errors.Join(ErrIDPExists, re)
	case "provider_not_found":
		return errors.Join(ErrIDPNotFound, re)
	}
	if re.Code == ErrCodeNotFound {
		return errors.Join(ErrIDPNotFound, re)
	}
	if re.Code == ErrCodeConflict {
		return errors.Join(ErrIDPExists, re)
	}
	return re
}
