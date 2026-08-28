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

	// APIKey — the realm's API key (rk_live_...). Never sent over login
	// traffic; the SDK exchanges it once for a short-lived platform token
	// (SPEC §4.0). Sugar for Credential = StaticAPIKey(APIKey). Optional when
	// Credential is set or when an ambient workload identity is available
	// (ADR-057); required otherwise.
	APIKey string

	// Credential overrides how the SDK bootstraps its platform session
	// (ADR-057). Leave nil to use APIKey, or, when APIKey is also empty, to
	// auto-detect an ambient workload identity (GCP / GitHub Actions). Set
	// explicitly via StaticAPIKey / GoogleWorkloadIdentity / GitHubActionsOIDC
	// to pin the source.
	Credential CredentialSource

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
	platformToken *sessionManager
	info          *infoClient
	verifier      *verifier
	revocation    RevocationCache

	Auth    *AuthClient
	Tenants *TenantsClient
	Domains *DomainsClient
	APIKeys *APIKeysClient
	// UserAPIKeys is the ADR-084 end-user key surface (SPEC §6.6). Separate from
	// APIKeys by design: an org admin managing members' keys must not thereby gain
	// platform-key power.
	UserAPIKeys *UserAPIKeysClient
	Config      *ConfigClient
	// Stats is the platform KPI rollup (orgs/users/sessions-24h/MFA
	// coverage) served by GET /platforms/{pid}/stats.
	Stats *StatsClient
	Roles *RolesClient
	// SigningKeys is the owner-facing signing-key read + self-serve rotate
	// surface (roles/signing-keys overhaul).
	SigningKeys *SigningKeysClient
	// IdentityProviderConfig is the realm-admin CRUD surface for
	// federated identity providers (distinct from the read-only
	// Realm.IdentityProviders SPA discovery method).
	IdentityProviderConfig *IdentityProviderConfigClient
	Origins                *OriginsClient
	Tokens                 *TokensClient
	Admin                  *AdminClient
	// AuditEvents exposes the partner audit-event feed (ADR-055).
	AuditEvents *AuditEventsClient
	// OTP exposes the partner OTP primitive (issue / view / verify) —
	// see docs/proposals/partner-otp-primitive.md in the auth repo.
	OTP *OTPClient
	// ServiceAccounts is the owner/admin service-account surface (ADR-071).
	ServiceAccounts *ServiceAccountsClient
	// Sources is the owner/admin app/source registry (ADR-072).
	Sources *SourcesClient
	// Integrations is the cross-realm integration surface (ADR-082/083):
	// source-side register/mint + target-side install/uninstall.
	Integrations *IntegrationsClient
	// FederationBindings is the platform's workload-identity federation
	// trust-binding surface (ADR-057).
	FederationBindings *FederationBindingsClient
	// Sessions is the owner/admin session-revocation surface (ADR-080):
	// force-logout a user or a realm-wide mass logout. Distinct from
	// AuthClient.RevokeAllSessions (the caller's own sessions).
	Sessions *SessionsClient
	// Me is the caller's OWN membership self-service (ADR-092 D5): settle the
	// single-tenant picker, decline an invitation, leave an org. Authorized by
	// the end user, never by the platform credential alone.
	Me *MeClient
}

// Version is the published SDK version (semver), and MUST equal the
// resolvable Go module tag it ships under (`go/vX.Y.Z`).
//
// It has no in-module consumers, so nothing breaks when it is wrong —
// which is why it drifted three times (go/v0.29.0 read "0.20.0" and
// misled a partner into thinking the ADR-071/072 service-account surface
// was unreleased; go/v0.35.0 read "0.34.0"; go/v0.44.0 read "0.38.0",
// six releases stale, while docs/integrator-sdk-pins.md was asking
// partners to report this exact number back to us as their pin).
//
// A comment saying "keep this in lockstep" was the prevention twice and
// failed twice. The prevention is now a CHECK:
// .github/workflows/verify-go-release.yml asserts this const equals the
// pushed tag. If that job goes red, the tag is already immutable (see
// root TODO.md § Tag hygiene) — fix the const and ship the next patch
// version; never re-point the tag.
//
// Per-release history belongs in CHANGELOG.md, not here. The accreted
// version-by-version narrative this comment used to carry was removed in
// the same change that added the check: duplicating release notes at the
// declaration is what made the stale value look maintained.
const Version = "0.49.0"

// NewRealm constructs a *Realm from cfg.
func NewRealm(cfg Config) (*Realm, error) {
	if cfg.RealmID == "" {
		return nil, errors.New("realmid: RealmID required")
	}
	// Resolve the bootstrap credential source (ADR-057): explicit Credential
	// wins; else a static APIKey; else auto-detect an ambient workload
	// identity (GCP / GitHub Actions).
	cred := cfg.Credential
	if cred == nil {
		if cfg.APIKey != "" {
			cred = StaticAPIKey(cfg.APIKey)
		} else {
			cred = autoDetectCredential(DefaultFederationAudience, cfg.HTTPClient)
		}
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
	r.platformToken = newSessionManager(cred, cfg.RealmID, r.http, cfg.Logger, cfg.Clock)
	r.revocation = cfg.Revocation
	r.info = &infoClient{realm: r}
	r.verifier = newVerifier(r)

	r.Auth = &AuthClient{realm: r}
	r.Tenants = newTenantsClient(r)
	r.Domains = &DomainsClient{realm: r}
	r.APIKeys = &APIKeysClient{realm: r}
	r.UserAPIKeys = &UserAPIKeysClient{realm: r}
	r.Config = &ConfigClient{realm: r}
	r.Stats = &StatsClient{realm: r}
	r.Roles = &RolesClient{realm: r}
	r.SigningKeys = &SigningKeysClient{realm: r}
	r.IdentityProviderConfig = &IdentityProviderConfigClient{realm: r}
	r.Origins = newOriginsClient(r)
	r.Tokens = newTokensClient(cfg.Clock)
	r.Admin = newAdminClient(r)
	r.AuditEvents = newAuditEventsClient(r)
	r.OTP = &OTPClient{realm: r}
	r.ServiceAccounts = &ServiceAccountsClient{realm: r}
	r.Sources = &SourcesClient{realm: r}
	r.Integrations = &IntegrationsClient{realm: r}
	r.FederationBindings = &FederationBindingsClient{realm: r}
	r.Sessions = &SessionsClient{realm: r}
	r.Me = &MeClient{realm: r}

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
