package realmid

import (
	ctxpkg "context"
	"net/url"
)

// Platform KPI rollup (issuer v0.52.0).
//
//	GET /platforms/{pid}/stats
//
// One request answers the whole dashboard strip — org + user counts, human
// sign-ins in the trailing 24h, and MFA coverage — from a single server-side
// query. Authorization is the ADR-074 `users:read` permission (the realm owner
// and the platform's own service/platform token are implicit-all); RealmID
// staff get no special path (ADR-067), so a platform you do not own is not
// readable. The server caches the rollup for 30 seconds, so polling faster
// than that returns the same snapshot.

// MFACoverage is the MFA-enrollment fraction of a platform's eligible user
// population, reported as its raw parts so a caller can render "8 of 40"
// rather than only a rounded percentage.
type MFACoverage struct {
	CoveredUsers  int `json:"covered_users"`
	EligibleUsers int `json:"eligible_users"`
	// Percent is nil when EligibleUsers == 0 — there is no coverage of an
	// empty population, and 0% would read as "nobody has MFA". Always
	// nil-check before dereferencing.
	Percent *float64 `json:"percent"`
}

// PlatformStats is the GET /platforms/{pid}/stats body.
type PlatformStats struct {
	PlatformID string `json:"platform_id"`
	// GeneratedAt is when the snapshot was computed (unix seconds). It can
	// lag "now" by up to the server's 30s cache window.
	GeneratedAt int64 `json:"generated_at"`
	// OrgsCount is the number of organizations (tenants) in the platform.
	OrgsCount int `json:"orgs_count"`
	// UsersCount is the platform's total user population.
	UsersCount int `json:"users_count"`
	// Sessions24h counts class="user" sessions CREATED in the trailing 24
	// hours — human sign-ins, not tokens minted and not sessions still alive.
	Sessions24h int         `json:"sessions_24h"`
	MFACoverage MFACoverage `json:"mfa_coverage"`
}

// StatsClient is realm.Stats.
type StatsClient struct {
	realm *Realm
}

// Get reads the platform's KPI rollup (30s server-side cache).
func (c *StatsClient) Get(ctx ctxpkg.Context) (*PlatformStats, error) {
	tok, err := c.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	var out PlatformStats
	if err := c.realm.http.do(ctx, requestOptions{
		Method: "GET",
		Path:   "/platforms/" + url.PathEscape(c.realm.realmID) + "/stats",
		Bearer: tok,
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
