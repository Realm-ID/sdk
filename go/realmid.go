// Package realmid is the Go SDK for Realm ID — covers login, refresh,
// MFA, verify, and the management surface (tenants, users, invitations,
// domains, API keys, config).
//
// A partner application using this SDK should never need to call
// auth.realmid.dev directly. Construct one *Realm at startup with a
// realm id and API key; every operation on that handle threads the
// dual-token (API-key → short-lived platform-token) flow internally
// so the raw API key never crosses login traffic.
//
// Usage:
//
//	realm, err := realmid.NewRealm(realmid.Config{
//	    RealmID: "01HXYZ...",
//	    APIKey:  "rk_live_...",
//	})
//	if err != nil { ... }
//	claims, err := realm.Verify(ctx, accessToken, nil)
//
// Stdlib only.
package realmid

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// DefaultBaseURL is the canonical Realm ID issuer host.
const DefaultBaseURL = "https://auth.realmid.dev"

// Config configures NewRealm. RealmID and APIKey are required; the rest
// have sensible defaults.
type Config struct {
	// RealmID — required. Your realm's UUID-ish identifier.
	RealmID string

	// APIKey — required. The realm's API key (rk_live_...). Never sent
	// over login traffic; the SDK exchanges it once for a short-lived
	// platform token (SPEC §4.0).
	APIKey string

	// BaseURL overrides the issuer host. Default: DefaultBaseURL.
	BaseURL string

	// Origin is the value attached to the Origin header on auth calls.
	// If unset, derived from realm.Info().Audience on first use.
	Origin string

	// Logger is the *slog.Logger the SDK emits diagnostics to.
	// Default: a slog logger over io.Discard (no-op).
	Logger *slog.Logger

	// HTTPClient overrides the underlying http.Client (handy in tests
	// for fake transports). Default: 30s timeout.
	HTTPClient *http.Client

	// Leeway is the verifier's clock-skew tolerance for exp/nbf checks.
	// Default 30s.
	Leeway time.Duration

	// Clock overrides time.Now. Useful in tests.
	Clock func() time.Time

	// Revocation is an optional JTI denylist consulted by Verify after
	// signature + claim checks (ADR-041 follow-up). Lets partners stop
	// the bleed on stolen access tokens between user logout and natural
	// JWT expiry. Nil → no-op; verifier behaves as before. Pass
	// NewMemRevocationCache(nil) for a single-process default, or supply
	// a Redis/memcached-backed implementation for multi-replica deploys.
	Revocation RevocationCache
}

// Realm is the SDK handle. Construct with NewRealm; safe for concurrent
// use across goroutines.
type Realm struct {
	cfg     Config
	realmID string
	baseURL string
	logger  *slog.Logger

	http          *httpClient
	platformToken *platformTokenManager
	info          *infoClient
	verifier      *verifier
	revocation    RevocationCache

	Auth    *AuthClient
	Tenants *TenantsClient
	Domains *DomainsClient
	APIKeys *APIKeysClient
	Config  *ConfigClient
	Roles   *RolesClient
	Origins *OriginsClient
	Tokens  *TokensClient
	Admin   *AdminClient
	// OTP exposes the partner OTP primitive (issue / view / verify) —
	// see docs/proposals/partner-otp-primitive.md in the auth repo.
	OTP *OTPClient
}

// Version is the published SDK version (semver). 0.5.0 corresponds to
// RealmID v0.5.0 — the platforms-namespace cut (ADR-044) and the
// signup_mode enum (ADR-045). Breaking: admin sub-paths moved from
// /realms/{id}/... to /platforms/{id}/... (api-keys, config, roles)
// and TenantCreate's `OpenSignup bool` is replaced by `SignupMode`
// (closed | allowlist | open). OIDC discovery URLs stay on /realms/.
const Version = "0.6.0"

// NewRealm constructs a *Realm from cfg.
func NewRealm(cfg Config) (*Realm, error) {
	if cfg.RealmID == "" {
		return nil, errors.New("realmid: RealmID required")
	}
	if cfg.APIKey == "" {
		return nil, errors.New("realmid: APIKey required")
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = DefaultBaseURL
	}
	cfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")
	if cfg.Logger == nil {
		cfg.Logger = noopLogger()
	}

	r := &Realm{
		cfg:     cfg,
		realmID: cfg.RealmID,
		baseURL: cfg.BaseURL,
		logger:  cfg.Logger,
	}
	r.http = newHTTPClient(cfg.BaseURL, cfg.HTTPClient, cfg.Logger)
	r.platformToken = newPlatformTokenManager(cfg.APIKey, cfg.RealmID, r.http, cfg.Logger, cfg.Clock)
	r.revocation = cfg.Revocation
	r.info = &infoClient{realm: r}
	r.verifier = newVerifier(r)

	r.Auth = &AuthClient{realm: r}
	r.Tenants = newTenantsClient(r)
	r.Domains = &DomainsClient{realm: r}
	r.APIKeys = &APIKeysClient{realm: r}
	r.Config = &ConfigClient{realm: r}
	r.Roles = &RolesClient{realm: r}
	r.Origins = newOriginsClient(r)
	r.Tokens = newTokensClient(cfg.Clock)
	r.Admin = newAdminClient(r)
	r.OTP = &OTPClient{realm: r}

	return r, nil
}

// RealmID returns the configured realm id.
func (r *Realm) RealmID() string { return r.realmID }

// Revocation returns the configured shared revocation cache, or nil when
// the SDK was constructed without one. Partner code can push directly to
// the cache (e.g., on detected token theft outside the normal Logout
// path) by calling cache.Revoke(ctx, jti, exp).
func (r *Realm) Revocation() RevocationCache { return r.revocation }

// BaseURL returns the configured issuer host.
func (r *Realm) BaseURL() string { return r.baseURL }

// Info returns cached realm metadata. First call hits the network;
// subsequent calls reuse the cached value for the lifetime of the
// handle.
func (r *Realm) Info(ctx context.Context) (*RealmInfo, error) {
	return r.info.Info(ctx)
}

// Verify parses, signature-verifies, and claim-checks an access token.
// Audience is auto-discovered via realm.Info() unless opts.Audience is
// set. JWKS are cached for 10 minutes per realm, with unknown-kid
// forcing a refetch.
func (r *Realm) Verify(ctx context.Context, token string, opts *VerifyOptions) (*Claims, error) {
	return r.verifier.Verify(ctx, token, opts)
}
