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

// PhoneOTPConfig is the typed view of the realm's `phone_otp` config group
// (ADR-115 B4; SPEC §6.5): how many phone codes (SMS and WhatsApp together) one
// number may be sent per window. Default 5 per 900s; RealmID's ceiling is 20 per
// 3600s. Written through the generic ConfigPatch, e.g.
// ConfigPatch{"phone_otp": map[string]any{"max_per_window": 8}} (a PATCH merges).
type PhoneOTPConfig struct {
	MaxPerWindow  int `json:"max_per_window"`
	WindowSeconds int `json:"window_seconds"`
	// SignInPerIPPerHour (ADR-116, spec 0.61.0) is how many sign-in codes one
	// end-user IP may request per hour (default 10, range 1-60, cannot be turned
	// off). 0 means the issuer did not send it (an older issuer).
	SignInPerIPPerHour int `json:"sign_in_per_ip_per_hour"`
}

// PhoneOTP reads the `phone_otp` group. nil means the issuer did not send it
// (an older issuer) or sent something unreadable; it is never a zeroed struct,
// which would invent a limit of 0.
func (v ConfigValues) PhoneOTP() *PhoneOTPConfig {
	m, ok := v["phone_otp"].(map[string]any)
	if !ok {
		return nil
	}
	max, ok1 := m["max_per_window"].(float64)
	win, ok2 := m["window_seconds"].(float64)
	if !ok1 || !ok2 {
		return nil
	}
	perIP, _ := m["sign_in_per_ip_per_hour"].(float64)
	return &PhoneOTPConfig{MaxPerWindow: int(max), WindowSeconds: int(win), SignInPerIPPerHour: int(perIP)}
}

// UniqueKinds reads the `contacts.unique_kinds` group (ADR-117 D1): which
// contact kinds ("email", "phone") are IDENTIFYING on this platform. The second
// result is false when the issuer did not send the group (an older issuer) or
// sent something unreadable; an explicit empty list is (empty, true), a legal
// and different answer, so test the bool, not len().
func (v ConfigValues) UniqueKinds() ([]string, bool) {
	g, ok := v["contacts"].(map[string]any)
	if !ok {
		return nil, false
	}
	if typed, ok := g["unique_kinds"].([]string); ok {
		return append([]string{}, typed...), true
	}
	raw, ok := g["unique_kinds"].([]any)
	if !ok {
		return nil, false
	}
	out := make([]string, 0, len(raw))
	for _, e := range raw {
		s, ok := e.(string)
		if !ok {
			return nil, false
		}
		out = append(out, s)
	}
	return out, true
}

// UniqueKindCount is one entry of ConfigResponse.UniqueKindsReport.
type UniqueKindCount struct {
	// ValuesOnMultipleMemberships counts the values of this kind that are proven
	// on more than one membership of the platform. Counts only, never the values.
	ValuesOnMultipleMemberships int `json:"values_on_multiple_memberships"`
}

// ConfigUpdateOptions are the per-call options of ConfigClient.UpdateWithOptions.
type ConfigUpdateOptions struct {
	// ConfirmLockout sends `?confirm_lockout=true` (ADR-117 D8), proceeding past
	// `409 unique_kind_lockout`. It is a QUERY parameter, never a header, and it
	// never escapes `503 unique_kind_lockout_check_failed` or any other refusal.
	ConfirmLockout bool
}

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
	// UniqueKindsReport (ADR-117), per contact kind, counts the values proven
	// on more than one membership. Derived and read-only, so it sits BESIDE
	// Config. nil means the issuer omitted it (the count could not be taken, or
	// an older issuer): never "zero everywhere".
	UniqueKindsReport map[string]UniqueKindCount `json:"unique_kinds_report,omitempty"`
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
	return c.UpdateWithOptions(ctx, patch, ConfigUpdateOptions{})
}

// UpdateWithOptions is Update with the per-call options (ConfirmLockout).
func (c *ConfigClient) UpdateWithOptions(ctx ctxpkg.Context, patch ConfigPatch, opts ConfigUpdateOptions) error {
	var query map[string]string
	if opts.ConfirmLockout {
		query = map[string]string{"confirm_lockout": "true"}
	}
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return err
	}
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "PATCH",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/config",
		Bearer: tok,
		Body:   patch,
		Query:  query,
	}, nil); err != nil {
		return err
	}
	// Invalidate cached realm.Info so the next read picks up any audience change.
	c.realm.info.invalidate()
	return nil
}
