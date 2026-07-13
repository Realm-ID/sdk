package realmid

import (
	ctxpkg "context"
	"net/url"
)

// Owner-facing signing-key surface (roles/signing-keys overhaul).
//
// A platform owner reads their realm's keyring and self-serve rotates the
// active signing key:
//   - GET  /platforms/{id}/signing-keys        — keyring + rotation policy
//   - POST /platforms/{id}/signing-keys/rotate — mint a new active key
//
// Distinct from the base-staff ops rotate at `/admin/platforms/{id}/…`
// (not part of this partner SDK). Both are realm-admin gated server-side;
// this client targets the caller's own realm.

// SigningKey is one key in the realm's signing keyring.
type SigningKey struct {
	KID string `json:"kid"`
	// CreatedAt is the unix-seconds timestamp the key was created.
	CreatedAt int64 `json:"created_at"`
	// ActiveUntil is when the key stops signing new tokens (unix seconds).
	ActiveUntil int64 `json:"active_until"`
	// RetireAt is when the key drops out of the JWKS entirely (unix seconds).
	RetireAt int64 `json:"retire_at"`
	// IsCurrent is true for the key currently minting tokens.
	IsCurrent bool `json:"is_current"`
}

// SigningKeyRotation is the realm's rotation policy.
type SigningKeyRotation struct {
	// Mode is "auto" or "manual".
	Mode string `json:"mode"`
	// Interval is the cadence ("1w"/"1mo"/"1y") when Mode=="auto"; empty
	// for manual or unset.
	Interval string `json:"interval,omitempty"`
	// NextRotationAt is when the worker next mints a replacement (unix
	// seconds); zero in manual mode.
	NextRotationAt int64 `json:"next_rotation_at,omitempty"`
}

// SigningKeysResponse is the GET /platforms/{id}/signing-keys body.
type SigningKeysResponse struct {
	Keys     []SigningKey       `json:"keys"`
	Rotation SigningKeyRotation `json:"rotation"`
}

// RotateSigningKeyResult is the rotate acknowledgment: the new current
// KID plus any KIDs retired by the rotation.
type RotateSigningKeyResult struct {
	KID         string   `json:"kid"`
	RetiredKIDs []string `json:"retired_kids"`
}

// SigningKeysClient is realm.SigningKeys.
type SigningKeysClient struct {
	realm *Realm
}

// List reads the realm's keyring (newest-first) and rotation policy.
func (c *SigningKeysClient) List(ctx ctxpkg.Context) (*SigningKeysResponse, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out SigningKeysResponse
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "GET",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/signing-keys",
		Bearer: tok,
	}, &out); err != nil {
		return nil, err
	}
	if out.Keys == nil {
		out.Keys = []SigningKey{}
	}
	return &out, nil
}

// Rotate self-serve rotates the realm's active signing key. Shares the
// server-side rotator + rate limiter with the ops route (a 429
// `rate_limited` RealmError is returned when called too frequently).
func (c *SigningKeysClient) Rotate(ctx ctxpkg.Context) (*RotateSigningKeyResult, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out RotateSigningKeyResult
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/signing-keys/rotate",
		Bearer: tok,
	}, &out); err != nil {
		return nil, err
	}
	if out.RetiredKIDs == nil {
		out.RetiredKIDs = []string{}
	}
	return &out, nil
}
