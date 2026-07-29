package realmid

import (
	ctxpkg "context"
	"encoding/json"
	"net/url"
)

// UserAPIKey is one entry from realm.UserAPIKeys.* (SPEC §6.6, ADR-084).
//
// DISTINCT from APIKey in every respect — separate table, separate route segment
// (`user-api-keys`), separate plaintext prefix (`uk_live_` vs `rk_live_`), and a
// separate permission pair (`user_api_keys:read|manage`). An org admin managing
// members' keys must not thereby gain platform-key power, and a leaked string
// should be classifiable at a glance.
//
// The struct unions the create-response and list-row wire shapes (issuer wins):
//
//   - On create: ID, Value (the one-time secret), Label, OrgScope, OrgIDs,
//     PermissionsCap, ExpiresAt.
//   - On list:   ID, Prefix, Label, OrgScope, OrgIDs, PermissionsCap,
//     MintedMFAAt, CreatedAt, LastUsedAt, ExpiresAt, RevokedAt.
type UserAPIKey struct {
	ID string `json:"id"`
	// Value is the raw secret, returned ONLY on create (one-time reveal).
	// Prefix `uk_live_`.
	Value string `json:"value,omitempty"`
	// Prefix is the non-secret hash prefix on list rows. With Label it is the
	// ONLY handle on a key — the plaintext is never returned again, so a found
	// uk_live_… cannot otherwise be correlated to its row.
	Prefix string `json:"prefix,omitempty"`
	Label  string `json:"label,omitempty"`
	// OrgScope is "selected" or "all". See OrgScopeSelected / OrgScopeAll.
	OrgScope string `json:"org_scope,omitempty"`
	// OrgIDs is the scope AS STORED. An org named here may no longer be
	// reachable: revocation on membership loss is an async sweep and live
	// membership is re-intersected at every exchange, so a key can LIST an org it
	// can no longer MINT into. Showing the stored value is the honest answer.
	OrgIDs []string `json:"org_ids,omitempty"`
	// PermissionsCap is a CAP, NEVER A GRANT. Effective authority is
	// PermissionsCap ∩ the principal's LIVE permissions, re-resolved per request,
	// so it can only ever UNDER-grant. Use CapAllows — do NOT test membership of
	// this slice on its own.
	PermissionsCap []string `json:"permissions_cap,omitempty"`
	// MintedMFAAt is load-bearing, not informational: key exchange is exempt from
	// the realm MFA floor if and only if it is set.
	MintedMFAAt *int64 `json:"minted_mfa_at,omitempty"`
	// CreatedAt / LastUsedAt / ExpiresAt / RevokedAt are unix seconds. A nil
	// ExpiresAt means non-expiring; a non-nil RevokedAt means revoked.
	CreatedAt  int64  `json:"created_at,omitempty"`
	LastUsedAt *int64 `json:"last_used_at,omitempty"`
	ExpiresAt  *int64 `json:"expires_at,omitempty"`
	RevokedAt  *int64 `json:"revoked_at,omitempty"`
}

// Org-scope modes (ADR-084 §6).
const (
	// OrgScopeSelected pins the key to a FROZEN allowlist, defaulting to just the
	// user's current org. Orgs joined later do NOT widen the key.
	OrgScopeSelected = "selected"
	// OrgScopeAll is FORWARD-INCLUSIVE: every org in the realm the user belongs
	// to, now and in future, resolved fresh at each exchange rather than
	// snapshotted. Gated on the realm's user_api_keys.allow_all_orgs because it
	// is the one mode that widens with no human in the loop.
	OrgScopeAll = "all"
)

// Revoked reports whether the key has been soft-revoked.
func (k UserAPIKey) Revoked() bool { return k.RevokedAt != nil }

// UserAPIKeyCreate is the mint payload. Label is required — it is the only
// human-readable handle on a key that never shows its plaintext again.
type UserAPIKeyCreate struct {
	Label string `json:"label"`
	// OrgScope defaults to the realm's user_api_keys.org_scope_default.
	OrgScope string `json:"org_scope,omitempty"`
	// OrgIDs defaults to just the user's current org. Every entry must be a live
	// membership of the target user, else 400 org_not_a_membership.
	OrgIDs []string `json:"org_ids,omitempty"`
	// PermissionsCap narrows the key. For the realmid audience these are
	// validated against RealmID's ADR-074 catalog at mint (400
	// unknown_permission); for a partner audience they are opaque to RealmID and
	// shape-validated only.
	PermissionsCap []string `json:"permissions_cap,omitempty"`
	// TTLSeconds omitted = the realm default. Above the realm ceiling returns
	// 400 ttl_exceeds_max. Zero requests a non-expiring key, which needs
	// user_api_keys.allow_non_expiring.
	TTLSeconds *int `json:"ttl_seconds,omitempty"`
}

// UserAPIKeysClient is realm.UserAPIKeys.
type UserAPIKeysClient struct {
	realm *Realm
}

func userAPIKeysPath(tenantID, userID string) string {
	return "/tenants/" + url.PathEscape(tenantID) +
		"/users/" + url.PathEscape(userID) + "/user-api-keys"
}

// Create mints a key for userID. userID MUST be the caller — keys are
// self-service, with no override: an admin minting a credential that
// authenticates AS a member is impersonation by another name, and ADR-039 is
// deliberately unbuilt.
//
// ADR-091 removed the user_api_keys.admin_mint_allowed escape hatch entirely.
// It is no longer a config key; PATCHing it answers 400 unknown_config_key.
//
// Value on the returned key is shown ONCE. Persist it at the call site or it is
// gone.
func (c *UserAPIKeysClient) Create(ctx ctxpkg.Context, tenantID, userID string, body UserAPIKeyCreate) (*UserAPIKey, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var k UserAPIKey
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   userAPIKeysPath(tenantID, userID),
		Bearer: tok,
		Body:   body,
	}, &k); err != nil {
		return nil, err
	}
	return &k, nil
}

// List returns every key for userID, INCLUDING revoked and expired ones — the
// surface shows them, and callers filter as needed. Never returns plaintext.
func (c *UserAPIKeysClient) List(ctx ctxpkg.Context, tenantID, userID string) ([]UserAPIKey, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var raw json.RawMessage
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "GET",
		Path:   userAPIKeysPath(tenantID, userID),
		Bearer: tok,
	}, &raw); err != nil {
		return nil, err
	}
	return decodeUserAPIKeyList(raw)
}

// Revoke soft-revokes a key. Idempotent.
func (c *UserAPIKeysClient) Revoke(ctx ctxpkg.Context, tenantID, userID, id string) error {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return err
	}
	return c.realm.http.do(ctx, requestOptions{
		Method: "DELETE",
		Path:   userAPIKeysPath(tenantID, userID) + "/" + url.PathEscape(id),
		Bearer: tok,
	}, nil)
}

// decodeUserAPIKeyList tolerates the issuer's {items} envelope or a flat array.
func decodeUserAPIKeyList(raw json.RawMessage) ([]UserAPIKey, error) {
	var env struct {
		Items []UserAPIKey `json:"items"`
	}
	if err := json.Unmarshal(raw, &env); err == nil && env.Items != nil {
		return env.Items, nil
	}
	var arr []UserAPIKey
	if err := json.Unmarshal(raw, &arr); err == nil {
		return arr, nil
	}
	return nil, &RealmError{Code: ErrCodeServerError, Message: "user-api-keys list: unexpected response shape"}
}

// LivePermissionResolver returns the permissions a principal holds RIGHT NOW,
// from the caller's own store. It is the second operand of the cap intersection.
type LivePermissionResolver func(ctxpkg.Context) ([]string, error)

// CapAllows reports whether `permission` is allowed for a key-derived token.
//
// Effective authority is `permissions_cap ∩ live permissions`, so BOTH operands
// must say yes. The live resolver is a REQUIRED parameter, not an option, and
// that is the entire design of this signature: the insecure one-operand form —
// "does the cap list this permission?" — is not expressible through this API, so
// a partner cannot implement the stale-scope semantics ADR-084 rejected by
// accident.
//
// Fails CLOSED. Returns false when:
//   - the cap omits the permission;
//   - the live set omits it;
//   - the resolver errors — an unavailable live operand means the intersection is
//     unknown, and the only safe reading of an unknown intersection is empty;
//   - resolver is nil, for the same reason.
//
// An ABSENT cap claim means the token is not key-derived and is not capped; that
// is signalled by claims carrying no permissions_cap at all, in which case only
// the live set governs. An EMPTY-but-present cap means "capped to nothing" and
// denies everything — the two are different states and must not be conflated.
//
// No pattern matching: RealmID never expands wildcards, applies hierarchy, or
// implies `*`, and neither does this.
func CapAllows(ctx ctxpkg.Context, claims *Claims, permission string, resolver LivePermissionResolver) bool {
	if claims == nil || permission == "" || resolver == nil {
		return false
	}
	capList, capped := capFromClaims(claims)
	if capped && !containsExact(capList, permission) {
		return false
	}
	live, err := resolver(ctx)
	if err != nil {
		return false
	}
	return containsExact(live, permission)
}

// capFromClaims extracts permissions_cap. The second return distinguishes
// "absent" (not a capped token) from "present but empty" (capped to nothing).
func capFromClaims(claims *Claims) ([]string, bool) {
	if claims == nil || claims.Extra == nil {
		return nil, false
	}
	raw, present := claims.Extra["permissions_cap"]
	if !present {
		return nil, false
	}
	switch v := raw.(type) {
	case []string:
		return v, true
	case []any:
		out := make([]string, 0, len(v))
		for _, e := range v {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
		return out, true
	}
	// Present but unparseable: the token asserts it is capped and we cannot tell
	// to what, so treat it as capped to nothing.
	return []string{}, true
}

func containsExact(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}
