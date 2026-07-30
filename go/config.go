package realmid

import (
	ctxpkg "context"
	"net/url"
)

// ConfigPatch is a partial patch of realm-level configuration (SPEC §6.5).
// The server enforces an allowlist of mutable keys; unknown keys are
// rejected with a 400.
type ConfigPatch map[string]any

// ConfigValues is the realm's configuration as served by
// GET /platforms/{id}/config.
//
// Deliberately a loose map, mirroring ConfigPatch on the write side: the
// key set is server-owned (the issuer derives it by reflection from its
// RealmConfigPatch struct and drift-tests it there), so a hand-maintained
// struct here would go stale the moment a key is added and would silently
// drop it. Read a key with a type assertion — note JSON numbers decode as
// float64:
//
//	cfg, _ := realm.Config.Get(ctx)
//	ttl, _ := cfg.Config["idle_ttl_seconds"].(float64)
//
// Server conventions (issuer realm.ConfigView):
//   - every allowlist key is ALWAYS present; the zero value means "unset"
//     (0 for ints, "" for strings, false for bools),
//   - access_token_custom_claim_keys is always an array, never null,
//   - refresh_absolute_expiry is always the full object
//     {mode ("rolling" when unset), daily_cutoff_local, timezone,
//     applies_to_service}.
type ConfigValues map[string]any

// ConfigResponse is the GET /platforms/{id}/config body: the realm id plus
// its configuration projected onto the PATCH allowlist key set.
type ConfigResponse struct {
	// ID is the realm (platform) id the config belongs to.
	ID string `json:"id"`
	// Config carries exactly the mutable-config key set. See ConfigValues.
	Config ConfigValues `json:"config"`
	// SingleTenantPendingReconciliation counts the people in this realm who
	// still hold 2+ ACTIVE memberships while `single_tenant_membership` is on
	// (ADR-092 D4). It sits BESIDE Config, not inside it, precisely because it
	// is DERIVED, read-only state — putting it in the settings bag would imply
	// it is settable, and PATCHing it answers 400 unknown_config_key.
	//
	// A pointer because the issuer reports it only while the rule is ON: nil
	// means "rule off / issuer does not report it", 0 means "on and fully
	// drained". Turning the rule on is allowed with violations outstanding —
	// the D5 picker drains them at each next login, so a user who never logs
	// in never resolves and this number is how an admin sees that.
	SingleTenantPendingReconciliation *int `json:"single_tenant_pending_reconciliation,omitempty"`
}

// ConfigClient is realm.Config.
type ConfigClient struct {
	realm *Realm
}

// Get issues GET /platforms/{id}/config — the read counterpart of Update.
// Authorization mirrors the PATCH exactly (the ADR-074 `platform:config`
// permission, or realm owner): anyone who may change the config may read it.
func (c *ConfigClient) Get(ctx ctxpkg.Context) (*ConfigResponse, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out ConfigResponse
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "GET",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/config",
		Bearer: tok,
	}, &out); err != nil {
		return nil, err
	}
	if out.Config == nil {
		out.Config = ConfigValues{}
	}
	return &out, nil
}

// Update issues PATCH /platforms/{id}/config.
func (c *ConfigClient) Update(ctx ctxpkg.Context, patch ConfigPatch) error {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return err
	}
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "PATCH",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/config",
		Bearer: tok,
		Body:   patch,
	}, nil); err != nil {
		return err
	}
	// Invalidate cached realm.Info so the next read picks up any audience change.
	c.realm.info.invalidate()
	return nil
}
