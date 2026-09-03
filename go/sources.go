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

// List paginates the realm's sources, including disabled ones.
//
// It returns a pager, NOT a slice: GET /sources is paginated server-side, so a
// slice could only ever be page one with no way for the caller to tell. Read
// Page(...).HasMore to detect truncation, or range over All to walk every page.
//
//	for src, err := range realm.Sources.List(ctx).All(ctx) { ... }
func (c *SourcesClient) List(ctx ctxpkg.Context) *Paginated[Source] {
	return newPaginated(func(ctx ctxpkg.Context, opts PageOpts) (*Page[Source], error) {
		pg, err := fetchFilteredPage[Source](ctx, c.realm, "/sources", opts,
			map[string]string{"platform_id": c.realm.realmID})
		if err != nil {
			return nil, mapSourceErr(err)
		}
		return pg, nil
	})
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
