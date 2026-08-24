package realmid

import (
	ctxpkg "context"
	"errors"
	"net/url"
)

// SourcesClient is realm.Sources — the owner/admin app/source registry
// (ADR-072). A source is a platform-level client app (web/android/ios/desktop
// human app, or the `bot` service-account app); its allowed_methods is
// mapping-2 (the login methods that app surfaces). Calls authenticate with the
// realm's platform token.
type SourcesClient struct {
	realm *Realm
}

// Source is one app/source registration (issuer sourceDTO).
type Source struct {
	ID             string   `json:"id"`
	PlatformID     string   `json:"platform_id"`
	Type           string   `json:"type"`
	Label          string   `json:"label"`
	AllowedMethods []string `json:"allowed_methods"`
	Enabled        bool     `json:"enabled"`
	CreatedAt      int64    `json:"created_at"`
}

// SourceCreate is the POST /sources body. A bot source may list only "otp"; a
// human source may never list "otp" (mapping-1 invariant, ADR-072 §0 —
// ErrSourceMethodViolatesKind on breach).
type SourceCreate struct {
	PlatformID     string   `json:"platform_id"`
	Type           string   `json:"type"`
	Label          string   `json:"label"`
	AllowedMethods []string `json:"allowed_methods,omitempty"`
}

// SourcePatch is a sparse PATCH /sources/{id} body; pointer fields = leave alone.
type SourcePatch struct {
	Label          *string   `json:"label,omitempty"`
	AllowedMethods *[]string `json:"allowed_methods,omitempty"`
	Enabled        *bool     `json:"enabled,omitempty"`
}

type sourceList struct {
	Items []Source `json:"items"`
}

// Source error sentinels.
var (
	// ErrSourceMethodViolatesKind is returned when allowed_methods is
	// incompatible with the source type (400 method_violates_kind).
	ErrSourceMethodViolatesKind = errors.New("realmid: source allowed_methods incompatible with type")
	// ErrSourceNotFound is returned when the source id doesn't resolve.
	ErrSourceNotFound = errors.New("realmid: source not found")
)

func mapSourceErr(err error) error {
	var re *RealmError
	if !errors.As(err, &re) {
		return err
	}
	switch specificCode(re) {
	case "method_violates_kind":
		return errors.Join(ErrSourceMethodViolatesKind, re)
	case "source_not_found":
		return errors.Join(ErrSourceNotFound, re)
	}
	if re.Code == ErrCodeNotFound {
		return errors.Join(ErrSourceNotFound, re)
	}
	return re
}

// List returns every source (including disabled) for the realm.
func (c *SourcesClient) List(ctx ctxpkg.Context) ([]Source, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out sourceList
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "GET", Path: "/sources", Bearer: tok,
		Query: map[string]string{"platform_id": c.realm.realmID},
	}, &out); err != nil {
		return nil, mapSourceErr(err)
	}
	if out.Items == nil {
		out.Items = []Source{}
	}
	return out.Items, nil
}

// Create registers a new app/source. PlatformID defaults to the realm.
func (c *SourcesClient) Create(ctx ctxpkg.Context, body SourceCreate) (*Source, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	if body.PlatformID == "" {
		body.PlatformID = c.realm.realmID
	}
	var out Source
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST", Path: "/sources", Bearer: tok, Body: body,
	}, &out); err != nil {
		return nil, mapSourceErr(err)
	}
	return &out, nil
}

// Update patches a source. allowed_methods is re-validated against the
// source's type server-side (mapping-2 can never weaken mapping-1).
func (c *SourcesClient) Update(ctx ctxpkg.Context, id string, patch SourcePatch) (*Source, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out Source
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "PATCH", Path: "/sources/" + url.PathEscape(id), Bearer: tok, Body: patch,
	}, &out); err != nil {
		return nil, mapSourceErr(err)
	}
	return &out, nil
}

// Delete removes a source.
func (c *SourcesClient) Delete(ctx ctxpkg.Context, id string) error {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return err
	}
	var out map[string]any
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "DELETE", Path: "/sources/" + url.PathEscape(id), Bearer: tok,
	}, &out); err != nil {
		return mapSourceErr(err)
	}
	return nil
}
