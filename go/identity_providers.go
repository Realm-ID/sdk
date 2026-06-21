package realmid

import (
	ctxpkg "context"
	"net/url"
)

// IdentityProvider is one row from the public identity-provider
// discovery endpoint. The shape mirrors the issuer's
// `publicIDPEntry`: admin-only fields are stripped, leaving the
// minimum the SPA needs to render its login provider list.
type IdentityProvider struct {
	Type       string `json:"type"`
	ClientType string `json:"client_type"`
	ClientID   string `json:"client_id"`
	// Config carries the provider's PUBLIC config (e.g. the Firebase web
	// config: apiKey/authDomain/appId); empty/absent for plain-OIDC providers.
	Config map[string]string `json:"config,omitempty"`
}

// IdentityProvidersResponse is the typed result of
// Realm.IdentityProviders. TenantID is set only when the issuer
// resolved the call to a specific tenant (origin-passthrough or
// explicit `tenant_id`); the SPA passes it through on
// POST /auth/login when present (required for method=google per
// ADR-046).
type IdentityProvidersResponse struct {
	TenantID  string             `json:"tenant_id,omitempty"`
	Providers []IdentityProvider `json:"providers"`
}

// IdentityProvidersOptions tunes the IdentityProviders call.
type IdentityProvidersOptions struct {
	// Platform narrows discovery to a single client surface
	// ("web" | "ios" | "android" | "desktop" | "other"). Empty
	// defaults to the issuer's behavior (currently "web").
	Platform string

	// TenantID pins discovery to a specific tenant on this realm.
	// When empty, the issuer falls back to Origin resolution (if
	// any) or realm-scope.
	TenantID string

	// Origin, when set, rides as the Origin header so the issuer's
	// domain-mappings lookup can resolve a tenant from the caller's
	// SPA origin (ADR-047 §1.0).
	Origin string
}

// IdentityProviders calls GET /platforms/{realm_id}/identity-providers
// — the public, platform-token-authed discovery endpoint used by SPAs
// to populate their login provider list. The realm's platform token
// is attached automatically (the call mints + caches it like every
// other SDK call).
func (r *Realm) IdentityProviders(ctx ctxpkg.Context, opts *IdentityProvidersOptions) (*IdentityProvidersResponse, error) {
	tok, err := r.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	query := map[string]string{}
	headers := map[string]string{}
	if opts != nil {
		if opts.Platform != "" {
			query["platform"] = opts.Platform
		}
		if opts.TenantID != "" {
			query["tenant_id"] = opts.TenantID
		}
		if opts.Origin != "" {
			headers["Origin"] = opts.Origin
		}
	}
	var resp IdentityProvidersResponse
	if err := r.http.do(ctx, requestOptions{
		Method:  "GET",
		Path:    "/platforms/" + url.PathEscape(r.realmID) + "/identity-providers",
		Query:   query,
		Bearer:  tok,
		Headers: headers,
	}, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}
