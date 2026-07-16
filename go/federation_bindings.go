package realmid

import (
	ctxpkg "context"
	"net/url"
)

// Avoid an unused-import error if a later cleanup removes the only
// ctxpkg-typed signature; see sdk/CLAUDE.md "Go SDK + GoFr hook quirk".
var _ = ctxpkg.Background

// FederationBinding is a workload-identity-federation trust binding
// (ADR-057). A workload OIDC assertion is accepted as a bootstrap
// credential for this platform iff its `iss` matches Issuer, its `aud`
// matches Audience, and every MatchClaims entry equals the corresponding
// assertion claim. LastUsedAt/CreatedAt are unix seconds.
type FederationBinding struct {
	ID          string            `json:"id"`
	PlatformID  string            `json:"platform_id"`
	RealmID     string            `json:"realm_id"`
	Issuer      string            `json:"issuer"`
	Audience    string            `json:"audience"`
	MatchClaims map[string]string `json:"match_claims"`
	MappedRole  string            `json:"mapped_role,omitempty"`
	Scope       []string          `json:"scope,omitempty"`
	Status      string            `json:"status"`
	LastUsedAt  int64             `json:"last_used_at,omitempty"`
	CreatedAt   int64             `json:"created_at,omitempty"`
}

// FederationBindingCreate is the create payload (ADR-057). Issuer must be an
// RI-known provider (v1: GCP accounts.google.com or GitHub
// token.actions.githubusercontent.com); MatchClaims must constrain at least
// the provider's mandatory claim. Audience is forced to the global RI
// constant server-side and cannot be set here.
type FederationBindingCreate struct {
	Issuer      string            `json:"issuer"`
	MatchClaims map[string]string `json:"match_claims"`
	// MappedRole is the role stamped on the minted platform session
	// (defaults to platform_api server-side).
	MappedRole string   `json:"mapped_role,omitempty"`
	Scope      []string `json:"scope,omitempty"`
}

// FederationBindingRevokeResult is the response from Revoke.
type FederationBindingRevokeResult struct {
	Status string `json:"status"`
	ID     string `json:"id"`
}

// FederationBindingsClient is realm.FederationBindings — the platform's
// workload-identity federation trust bindings (ADR-057).
type FederationBindingsClient struct {
	realm *Realm
}

// List paginates the platform's federation bindings.
func (c *FederationBindingsClient) List(ctx ctxpkg.Context) *Paginated[FederationBinding] {
	path := "/platforms/" + url.PathEscape(c.realm.realmID) + "/federation-bindings"
	return newPaginated(func(ctx ctxpkg.Context, opts PageOpts) (*Page[FederationBinding], error) {
		return fetchPage[FederationBinding](ctx, c.realm, path, opts)
	})
}

// Create registers a federation binding. 409 binding_exists if an active
// binding already has the same (issuer, match_claims) tuple.
func (c *FederationBindingsClient) Create(ctx ctxpkg.Context, body FederationBindingCreate) (*FederationBinding, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out FederationBinding
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/federation-bindings",
		Bearer: tok,
		Body:   body,
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Revoke soft-deletes (revokes) a binding by id: it is marked status=revoked
// and immediately stops authenticating workloads, but the row is retained for
// audit. A second call on an already-removed id returns 404.
func (c *FederationBindingsClient) Revoke(ctx ctxpkg.Context, bindingID string) (*FederationBindingRevokeResult, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out FederationBindingRevokeResult
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "DELETE",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/federation-bindings/" + url.PathEscape(bindingID),
		Bearer: tok,
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
