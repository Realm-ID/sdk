package realmid

import (
	ctxpkg "context"
	"encoding/json"
	"net/url"
	"time"
)

// APIKey is one entry from realm.APIKeys.* (SPEC §6.5). The struct is a
// union of the create-response and list-row wire shapes (issuer wins —
// see issuer swagger APIKey / APIKeyListItem):
//
//   - On create: ID, Value (the one-time secret), Scope, Label, ExpiresAt.
//   - On list:   ID, Prefix, Label, Role, CreatedAt, LastUsedAt, ExpiresAt,
//     RevokedAt are set.
//
// The issuer's create request uses `scope` while the list row reports
// `role`; the SDK surfaces both fields rather than papering over the
// asymmetry (logged for the issuer in sdk/TODO.md).
type APIKey struct {
	ID string `json:"id"`
	// Value is the raw secret key, returned ONLY on create (one-time reveal).
	Value string `json:"value,omitempty"`
	// Scope is echoed on create.
	Scope string `json:"scope,omitempty"`
	// Label is echoed on create AND returned on every list row (issuer
	// v0.61.0, ADR-085 §7). It is the only handle on a key: the plaintext is
	// never echoed and Prefix is derived from the stored hash, so an
	// rk_live_… found in a log cannot be traced to its row by value.
	Label string `json:"label,omitempty"`
	// Prefix is the non-secret key prefix (list rows), stable across logs.
	Prefix string `json:"prefix,omitempty"`
	// Role is the key's bound role as reported by the list endpoint.
	Role string `json:"role,omitempty"`
	// CreatedAt / LastUsedAt / RevokedAt are unix seconds (list rows).
	// LastUsedAt and RevokedAt are nil when the server omits them; a
	// non-nil RevokedAt means the key has been revoked.
	CreatedAt  int64  `json:"created_at,omitempty"`
	LastUsedAt *int64 `json:"last_used_at,omitempty"`
	RevokedAt  *int64 `json:"revoked_at,omitempty"`
	// ExpiresAt is the scheduled cutoff in unix seconds, nil for a
	// non-expiring key (ADR-085 §3). An expired key behaves exactly like a
	// revoked one at login and returns the same error envelope, so the two are
	// indistinguishable to a key holder — check Expired() and Revoked()
	// separately when you need to tell an operator which it was.
	ExpiresAt *int64 `json:"expires_at,omitempty"`
}

// Expired reports whether the key is past its scheduled cutoff as of now.
// A non-expiring key (ExpiresAt nil) is never expired.
func (k APIKey) Expired(now time.Time) bool {
	return k.ExpiresAt != nil && now.Unix() >= *k.ExpiresAt
}

// Revoked reports whether the key has been soft-deleted (revoked_at set).
func (k APIKey) Revoked() bool { return k.RevokedAt != nil }

// APIKeyCreate is the create payload. `Scope` is required; `Label` is an
// optional human-readable name.
type APIKeyCreate struct {
	Scope string `json:"scope"`
	Label string `json:"label,omitempty"`
	// TTLSeconds is the requested lifetime (ADR-085 §3). Omitting it AND
	// NonExpiring applies the issuer's built-in 90-day default. The floor is
	// 300s and a smaller value is REJECTED rather than clamped — clamping up
	// would hand back a key that outlives what was asked for.
	TTLSeconds int64 `json:"ttl_seconds,omitempty"`
	// NonExpiring requests a permanent key. A realm may hold at most one, and
	// at most 2 active platform keys in total (ADR-085 §2), so create can fail
	// with non_expiring_not_allowed or too_many_api_keys.
	NonExpiring bool `json:"non_expiring,omitempty"`
}

// APIKeysClient is realm.APIKeys.
type APIKeysClient struct {
	realm *Realm
}

func (c *APIKeysClient) Create(ctx ctxpkg.Context, body APIKeyCreate) (*APIKey, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var k APIKey
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/api-keys",
		Bearer: tok,
		Body:   body,
	}, &k); err != nil {
		return nil, err
	}
	return &k, nil
}

// List returns every API key associated with this realm. The issuer
// returns a paginated {items, next_cursor, total} envelope; we also
// accept a flat array or a legacy {api_keys} envelope for resilience.
func (c *APIKeysClient) List(ctx ctxpkg.Context) ([]APIKey, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var raw json.RawMessage
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "GET",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/api-keys",
		Bearer: tok,
	}, &raw); err != nil {
		return nil, err
	}
	return decodeAPIKeyList(raw)
}

func (c *APIKeysClient) Revoke(ctx ctxpkg.Context, id string) error {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return err
	}
	return c.realm.http.do(ctx, requestOptions{
		Method: "DELETE",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/api-keys/" + url.PathEscape(id),
		Bearer: tok,
	}, nil)
}

// decodeAPIKeyList tolerates the issuer's {items} envelope, a legacy
// {api_keys} envelope, or a flat array. Decoding straight into the typed
// APIKey struct picks up the wire field names (role/prefix/last_used_at)
// without manual key walking.
func decodeAPIKeyList(raw json.RawMessage) ([]APIKey, error) {
	var env struct {
		Items   []APIKey `json:"items"`
		APIKeys []APIKey `json:"api_keys"`
	}
	if err := json.Unmarshal(raw, &env); err == nil {
		if env.Items != nil {
			return env.Items, nil
		}
		if env.APIKeys != nil {
			return env.APIKeys, nil
		}
	}
	var arr []APIKey
	if err := json.Unmarshal(raw, &arr); err == nil {
		return arr, nil
	}
	return nil, &RealmError{Code: ErrCodeServerError, Message: "api-keys list: unexpected response shape"}
}
