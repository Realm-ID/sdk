package realmid

import (
	ctxpkg "context"
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
//   - On create: ID, Value (the one-time secret), Label, OrgID, PermissionsCap,
//     ExpiresAt.
//   - On list:   ID, Prefix, Label, OrgID, PermissionsCap, MintedMFAAt,
//     CreatedAt, LastUsedAt, ExpiresAt, RevokedAt.
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
	// OrgID is the ONE org this key mints into (ADR-105): the minting
	// principal's own tenant, never client-supplied.
	//
	// It may briefly outlive the membership it depends on — revocation on
	// membership loss is an async sweep and live membership is re-checked at
	// every exchange — so a key can LIST an org it can no longer MINT into.
	// Showing the stored value is the honest answer.
	OrgID string `json:"org_id,omitempty"`
	// Uncapped reports that the key carries the holder's FULL authority — all
	// current and future permissions. Mutually exclusive with a non-empty
	// PermissionsCap: exactly one of the two describes the key (ADR-100 D2).
	Uncapped bool `json:"uncapped,omitempty"`
	// PermissionsCap is a CAP, NEVER A GRANT. Effective authority is
	// PermissionsCap ∩ the principal's LIVE permissions, re-resolved per request,
	// so it can only ever UNDER-grant. Use CapAllows — do NOT test membership of
	// this slice on its own. Absent or empty when Uncapped; otherwise non-empty
	// — the server cannot store an empty cap (ADR-100 D1).
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

// ⚠️ ADR-084 §6's ORG-SCOPE MODES ARE GONE (ADR-105). `OrgScopeSelected` and
// `OrgScopeAll` no longer exist, and neither does the concept: a key is bound to
// exactly ONE org, `UserAPIKey.OrgID`.
//
// `all` meant "every org in this realm the holder belongs to, now and in
// future", resolved fresh at each exchange — the one mode that widened with no
// human in the loop. Prod held ZERO keys of either shape when it was measured
// (2026-08-31), so it went out as a deletion rather than a deprecation.
//
// A caller needing a credential across N orgs mints N keys. Strictly better:
// revoking one then revokes one, and a key's compromise no longer spans orgs.

// Revoked reports whether the key has been soft-revoked.
func (k UserAPIKey) Revoked() bool { return k.RevokedAt != nil }

// UserAPIKeyWrite is the write payload, shared by Create and Update
// (ADR-100 D12). Label is required — it is the only human-readable handle on a
// key that never shows its plaintext again.
//
// ⚠️ UPDATE RESETS WHAT IT OMITS. Update is a PUT, not a PATCH: it replaces the
// whole key, so a caller changing only the cap must READ THE KEY FIRST and send
// Label back unchanged. Send just the cap and the label is blanked. That is the
// price of one write schema instead of two, and it is deliberate — PATCH would
// make PermissionsCap and Uncapped an order-dependent pair that can arrive
// half-specified.
//
// ⚠️ ADR-105 REMOVED OrgScope and OrgIDs from this struct. A key is bound to the
// minting principal's own org and the mint takes no org input at all. The fields
// are GONE rather than accepted-and-ignored: a struct tag left behind would look
// like a live knob.
type UserAPIKeyWrite struct {
	Label string `json:"label"`
	// Uncapped is REQUIRED — a key's authority is stated, never inferred
	// (ADR-100).
	//
	// True means ALL CURRENT AND FUTURE permissions of the holder, and needs the
	// realm's user_api_keys.allow_uncapped (403 uncapped_not_allowed otherwise).
	// False requires a non-empty PermissionsCap.
	//
	// A POINTER, and deliberately NOT omitempty: those two together are what make
	// "I did not say" a distinct, transmissible state rather than a silent false.
	// A nil Uncapped marshals to JSON null and the server answers 400 — which is
	// the entire point of the field. Before ADR-100 an absent permissions_cap
	// produced a key carrying the holder's FULL authority, so a console that
	// ticked nothing granted everything, and the wire could not tell that mistake
	// from the deliberate case.
	//
	// An operator who wants TODAY's permission set frozen names today's
	// permissions explicitly. Uncapped is not a shorthand for it: it is
	// forward-inclusive.
	Uncapped *bool `json:"uncapped"`
	// PermissionsCap narrows the key. For the realmid audience these are
	// validated against RealmID's ADR-074 catalog at mint (400
	// unknown_permission); for a partner audience they are opaque to RealmID and
	// shape-validated only.
	//
	// Must be non-empty when Uncapped is false, and empty when Uncapped is true —
	// the two together are self-contradicting and are refused (400).
	PermissionsCap []string `json:"permissions_cap,omitempty"`
	// TTLSeconds omitted = the realm default. Above the realm ceiling returns
	// 400 ttl_exceeds_max. Zero requests a non-expiring key, which needs
	// user_api_keys.allow_non_expiring. Mutable on Update (ADR-100 D13).
	TTLSeconds *int `json:"ttl_seconds,omitempty"`
}

// UserAPIKeyCreate is the create half of UserAPIKeyWrite. Same schema; one
// shape.
type UserAPIKeyCreate = UserAPIKeyWrite

// Uncapped returns a pointer to v, for UserAPIKeyWrite.Uncapped.
//
// It exists because that field must be a pointer (see the doc there) and Go has
// no address-of for a literal, so without this every call site would need a
// throwaway variable — friction on the field the design most wants people to
// state.
func Uncapped(v bool) *bool { return &v }

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
func (c *UserAPIKeysClient) Create(ctx ctxpkg.Context, tenantID, userID string, body UserAPIKeyWrite) (*UserAPIKey, error) {
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

// List paginates userID's keys, INCLUDING revoked and expired ones — the
// surface shows them, and callers filter as needed. Never returns plaintext.
//
// It returns a pager, NOT a slice. This endpoint has claimed to be paginated
// for longer than it has been one: `next_cursor` and `total` were hard-wired
// null while `limit`/`cursor` were documented and unread, so a caller that
// trusted the wire terminated after a single complete page. Now that the SQL is
// real, HasMore is the truncation signal — do not infer it from len(Items).
//
//	for k, err := range realm.UserAPIKeys.List(ctx, tenantID, userID).All(ctx) { ... }
func (c *UserAPIKeysClient) List(ctx ctxpkg.Context, tenantID, userID string) *Paginated[UserAPIKey] {
	return newPaginated(func(ctx ctxpkg.Context, opts PageOpts) (*Page[UserAPIKey], error) {
		return fetchPage[UserAPIKey](ctx, c.realm, userAPIKeysPath(tenantID, userID), opts)
	})
}

// Update replaces a key in place (ADR-100 D12) — cap, label and TTL.
// The key's SECRET is untouched: Update never re-issues plaintext and the
// returned key carries no Value.
//
// ⚠️ This is a PUT: IT RESETS WHAT IT OMITS. Read the key, change the one field,
// send the whole shape back. See UserAPIKeyWrite.
//
// Widening — Uncapped false→true, adding permissions, extending the TTL — is
// gated by the same MFA step-up as the
// mint (user_api_keys.require_mfa_at_mint). It has to be: a key minted narrowly
// and then widened through an unguarded update would make the mint's gate
// decorative.
//
// A cap change takes effect at the NEXT token mint. Access tokens already issued
// keep the bound they were minted with until they expire.
func (c *UserAPIKeysClient) Update(ctx ctxpkg.Context, tenantID, userID, id string, body UserAPIKeyWrite) (*UserAPIKey, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var k UserAPIKey
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "PUT",
		Path:   userAPIKeysPath(tenantID, userID) + "/" + url.PathEscape(id),
		Bearer: tok,
		Body:   body,
	}, &k); err != nil {
		return nil, err
	}
	return &k, nil
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
