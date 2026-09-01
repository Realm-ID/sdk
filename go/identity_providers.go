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

	// CredentialMethods are the NON-IdP login methods the realm can
	// actually complete: "password" (ADR-104) and "otp" (ADR-103).
	//
	// ⚠️ THIS FIELD MUST EXIST HERE EVEN IF NO GO CALLER READS IT. The
	// reference BFF decodes the issuer's response into this struct and
	// re-serialises it to the browser, so a field missing from this type
	// is DELETED from the response the login screen sees — silently, with
	// no error anywhere. That is exactly what shipped: the issuer
	// advertised `credential_methods`, the browser SDK mapped it, the
	// console rendered from it, and this struct dropped it in between, so
	// credential sign-in was unreachable from any BFF-fronted console.
	//
	// ABSENT means "the server did not say", never "none" — an older
	// issuer omits the field, and reading absence as an empty list tells a
	// login screen credential login is off when it is not.
	CredentialMethods []string `json:"credential_methods,omitempty"`
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
