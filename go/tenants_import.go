package realmid

import (
	ctxpkg "context"
	"net/url"
)

// ImportUserRow is one row for UsersClient.ImportUsers (ADR-073 Release B).
// At least one of Email/Phone is required.
type ImportUserRow struct {
	// UserID is an optional caller-supplied UUID. When present it becomes
	// users.id (bring-your-own; reconciles if it already exists in THIS
	// tenant, rejects the whole file if it exists in another). When absent a
	// UUIDv7 is minted and returned in the row result.
	UserID string `json:"user_id,omitempty"`
	Email  string `json:"email,omitempty"`
	// Phone is an E.164 number (leading '+').
	Phone       string `json:"phone,omitempty"`
	Role        string `json:"role"`
	DisplayName string `json:"display_name,omitempty"`
	// Provider, with ProviderUID, writes an exact first-SSO binding
	// ("google" | "microsoft" | "apple" | "facebook" | "firebase").
	Provider    string `json:"provider,omitempty"`
	ProviderUID string `json:"provider_uid,omitempty"`
	// CreatedAt is an optional RFC3339 "member since" timestamp (ADR-073 C.4);
	// absent ⇒ import-time. Rejected with `invalid_created_at` if malformed.
	CreatedAt string `json:"created_at,omitempty"`
}

// ImportUserRowResult is the per-row report entry in an import response.
type ImportUserRowResult struct {
	// Line is the 1-based row index.
	Line int `json:"line"`
	// UserID is the bring-your-own or minted-and-returned users.id.
	UserID     string `json:"user_id,omitempty"`
	Identifier string `json:"identifier,omitempty"`
	// Status ∈ {created, updated, failed, ok}.
	Status    string `json:"status"`
	Error     string `json:"error,omitempty"`
	ErrorHint string `json:"error_hint,omitempty"`
}

// ImportUsersResult is the response from UsersClient.ImportUsers. The call
// always resolves HTTP 200 (ADR-069 uniform-200): inspect Committed, not the
// status code. When Committed is false, validation rejected the file and
// NOTHING was written — each failing row carries Error + ErrorHint.
type ImportUsersResult struct {
	Committed bool                  `json:"committed"`
	Imported  int                   `json:"imported"`
	Updated   int                   `json:"updated"`
	Failed    int                   `json:"failed"`
	Rows      []ImportUserRowResult `json:"rows"`
}

// ImportUsers bulk-imports pre-provisioned ACTIVE users into a tenant
// (ADR-073 Release B, POST /tenants/{id}/users/import). Two-phase and
// whole-file-atomic on validation: when the returned Committed is false
// nothing was written. A row may bring its own UserID (becomes users.id);
// rows without one get a minted id returned in the row result.
func (c *UsersClient) ImportUsers(ctx ctxpkg.Context, tenantID string, rows []ImportUserRow) (*ImportUsersResult, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out ImportUsersResult
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/tenants/" + url.PathEscape(tenantID) + "/users/import",
		Bearer: tok,
		Body:   map[string]any{"users": rows},
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
