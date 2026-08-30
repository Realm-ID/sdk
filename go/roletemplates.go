package realmid

import (
	ctxpkg "context"
	"errors"
	"net/url"
)

// roletemplates.go — ADR-101 D1's write side: RealmID's role VOCABULARY.
//
// Distinct from RolesClient, and the distinction is the whole ADR. A ROLE
// belongs to one realm and has holders; a TEMPLATE is the recipe a role is
// stamped from, and it belongs to RealmID. Partners cannot reach this surface
// at all — every route behind it is base-realm-gated (D4) and answers
// ErrRoleAuthoringRetired anywhere else. It is in the SDK because RealmID's own
// console is an SDK consumer like any other.

// Errors specific to the vocabulary surface.
var (
	// ErrRoleTemplateExists is a collision on the (level, name) identity.
	ErrRoleTemplateExists = errors.New("realmid: role template already exists")
	// ErrRoleTemplateNotFound is a read or write against an unknown id.
	ErrRoleTemplateNotFound = errors.New("realmid: role template not found")
	// ErrRoleTemplateIdentityImmutable is an attempt to change a template's
	// level or name. A rename is a delete plus a create — conflating them would
	// orphan every role already stamped from the old name.
	ErrRoleTemplateIdentityImmutable = errors.New("realmid: role template level and name are immutable")
	// ErrRoleTemplatesUnavailable means the deployment wired no writable
	// vocabulary store (501).
	ErrRoleTemplatesUnavailable = errors.New("realmid: role templates unavailable in this deployment")
)

// Role-template levels. (Level, Name) is the identity: the SAME name at both
// levels is two different roles with different authority — a platform `admin`
// runs a realm, a tenant `admin` runs one org.
const (
	RoleTemplateLevelPlatform = "platform"
	RoleTemplateLevelTenant   = "tenant"
)

// RoleTemplate is one row of RealmID's role vocabulary.
type RoleTemplate struct {
	ID           string   `json:"id"`
	Level        string   `json:"level"`
	Name         string   `json:"name"`
	DisplayName  string   `json:"display_name"`
	Permissions  []string `json:"permissions"`
	AssignableTo []string `json:"assignable_to"`
	IsSystem     bool     `json:"is_system"`
	// Optional false means the template is part of the FLOOR every realm
	// receives, and creating it FANS OUT to existing realms. True means it is
	// created only when named.
	Optional  bool  `json:"optional"`
	CreatedAt int64 `json:"created_at,omitempty"`
	UpdatedAt int64 `json:"updated_at,omitempty"`
}

// RoleTemplateCreate is the create body.
type RoleTemplateCreate struct {
	Level        string   `json:"level"`
	Name         string   `json:"name"`
	DisplayName  string   `json:"display_name,omitempty"`
	Permissions  []string `json:"permissions,omitempty"`
	AssignableTo []string `json:"assignable_to"`
	IsSystem     bool     `json:"is_system,omitempty"`
	Optional     bool     `json:"optional,omitempty"`
}

// RoleTemplatePatch is the patch body. Every field is a pointer so an OMITTED
// key preserves the stored value; `level` and `name` are absent by design.
type RoleTemplatePatch struct {
	DisplayName  *string   `json:"display_name,omitempty"`
	Permissions  *[]string `json:"permissions,omitempty"`
	AssignableTo *[]string `json:"assignable_to,omitempty"`
	IsSystem     *bool     `json:"is_system,omitempty"`
	Optional     *bool     `json:"optional,omitempty"`
}

// RoleTemplateCreated is the create response.
type RoleTemplateCreated struct {
	RoleTemplate RoleTemplate `json:"role_template"`
	// RealmsStamped is how many realm role rows the fan-out created. Zero for
	// an optional template and for a floor template every realm already held.
	RealmsStamped int `json:"realms_stamped"`
}

// RoleTemplatePatched is the patch response.
type RoleTemplatePatched struct {
	RoleTemplate RoleTemplate `json:"role_template"`
	// DriftedRealms is how many realms now hold something different from the
	// template. An edit does NOT propagate, so this is the drift the edit just
	// created.
	//
	// ⚠️ -1 means the count COULD NOT BE TAKEN. It never means "none" — treat it
	// as unknown, not as a clean bill of health.
	DriftedRealms int `json:"drifted_realms"`
}

// RoleTemplateDeleted is the delete response.
type RoleTemplateDeleted struct {
	Status string `json:"status"`
	// RealmsStillHolding is how many realms still hold a role stamped from the
	// deleted template. The vocabulary row is gone; those roles and their
	// holders are not. -1 means the count could not be taken.
	RealmsStillHolding int `json:"realms_still_holding"`
}

type roleTemplateList struct {
	RoleTemplates []RoleTemplate `json:"role_templates"`
}

// RoleTemplatesClient is realm.RoleTemplates.
type RoleTemplatesClient struct {
	realm *Realm
}

func (c *RoleTemplatesClient) base() string {
	return "/platforms/" + url.PathEscape(c.realm.realmID) + "/role-templates"
}

// List returns RealmID's role vocabulary. An empty level returns both levels.
func (c *RoleTemplatesClient) List(ctx ctxpkg.Context, level string) ([]RoleTemplate, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	q := map[string]string{}
	if level != "" {
		q["level"] = level
	}
	var out roleTemplateList
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "GET", Path: c.base(), Bearer: tok, Query: q,
	}, &out); err != nil {
		return nil, mapRoleTemplateErr(err)
	}
	if out.RoleTemplates == nil {
		out.RoleTemplates = []RoleTemplate{}
	}
	return out.RoleTemplates, nil
}

// Create adds a role to RealmID's vocabulary.
//
// A non-optional (floor) template FANS OUT to every realm governed at its
// level. Read RealmsStamped on the result: it is the difference between "the
// role exists for realms created from now on" and "the role reached the realms
// that already exist", and only the second is what ADR-101 promises.
func (c *RoleTemplatesClient) Create(ctx ctxpkg.Context, body RoleTemplateCreate) (*RoleTemplateCreated, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out RoleTemplateCreated
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST", Path: c.base(), Bearer: tok, Body: body,
	}, &out); err != nil {
		return nil, mapRoleTemplateErr(err)
	}
	return &out, nil
}

// Update patches a template's mutable fields.
//
// It changes the RECIPE only — realms already holding a role stamped from this
// template keep what they were stamped with. The returned DriftedRealms is the
// drift that creates, and -1 there means "could not count", never "none".
func (c *RoleTemplatesClient) Update(ctx ctxpkg.Context, templateID string, patch RoleTemplatePatch) (*RoleTemplatePatched, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out RoleTemplatePatched
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "PATCH", Path: c.base() + "/" + url.PathEscape(templateID),
		Bearer: tok, Body: patch,
	}, &out); err != nil {
		return nil, mapRoleTemplateErr(err)
	}
	return &out, nil
}

// Delete removes a template from the vocabulary.
//
// Roles already stamped from it KEEP their rows and their holders — removing a
// role from a realm is a membership change, not a side effect of tidying a
// vocabulary row. RealmsStillHolding reports the orphans this creates.
func (c *RoleTemplatesClient) Delete(ctx ctxpkg.Context, templateID string) (*RoleTemplateDeleted, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out RoleTemplateDeleted
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "DELETE", Path: c.base() + "/" + url.PathEscape(templateID),
		Bearer: tok,
	}, &out); err != nil {
		return nil, mapRoleTemplateErr(err)
	}
	return &out, nil
}

// mapRoleTemplateErr turns the wire codes into sentinels.
//
// It reuses specificCode, which reads the code from BOTH envelope levels — the
// nested `error.code` and the top level. A reader that checks only one is the
// defect that made role_owner_only arrive as a plain `forbidden`.
func mapRoleTemplateErr(err error) error {
	var re *RealmError
	if !errors.As(err, &re) {
		return err
	}
	switch specificCode(re) {
	case "role_template_exists":
		return errors.Join(ErrRoleTemplateExists, re)
	case "role_template_not_found":
		return errors.Join(ErrRoleTemplateNotFound, re)
	case "role_template_identity_immutable":
		return errors.Join(ErrRoleTemplateIdentityImmutable, re)
	case "role_templates_unavailable":
		return errors.Join(ErrRoleTemplatesUnavailable, re)
	case "role_authoring_retired":
		// The SAME sentinel the role-authoring routes return. A partner reaching
		// the vocabulary and a partner authoring a role are one refusal with one
		// remedy (ADR-097 scopes), and giving them two error values would imply
		// two different answers.
		return errors.Join(ErrRoleAuthoringRetired, re)
	}
	return mapRoleErr(err)
}
