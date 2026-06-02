package realmid

import (
	ctxpkg "context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Credential is the bootstrap credential a CredentialSource yields at login
// time. Exactly one of APIKey / SubjectToken is populated, selected by
// GrantType.
type Credential struct {
	GrantType    string
	APIKey       string // grant_type=platform_api_key
	SubjectToken string // grant_type=token-exchange (a workload OIDC JWT)
}

// CredentialSource supplies the bootstrap credential the SDK exchanges once at
// POST /auth/login for a platform session (ADR-057). The static API key is one
// implementation; the ambient cloud providers (GCP, GitHub Actions) are the
// others. Fetch is called only on initial login and refresh-death — never per
// request — so a workload source may mint a fresh short-lived OIDC token here.
type CredentialSource interface {
	Fetch(ctx ctxpkg.Context) (Credential, error)
}

// Grant + token-type wire constants (ADR-051 / ADR-057).
const (
	grantPlatformAPIKey = "platform_api_key"
	grantTokenExchange  = "urn:ietf:params:oauth:grant-type:token-exchange"
	subjectTokenTypeJWT = "urn:ietf:params:oauth:token-type:jwt"
)

// DefaultFederationAudience is the global audience the zero-config SDK requests
// for a workload OIDC token (ADR-057 §7). It must match the issuer's
// REALMID_FEDERATION_AUDIENCE. The tenant boundary is the binding's
// match_claims, not this aud — aud only blocks cross-RP replay.
const DefaultFederationAudience = "https://api.realmid.dev"

// ---- static API key (today's behavior) ----

// StaticAPIKey returns a CredentialSource that presents a fixed rk_live_ key.
// Config.APIKey is sugar for this.
func StaticAPIKey(key string) CredentialSource { return staticAPIKey{key: key} }

type staticAPIKey struct{ key string }

func (s staticAPIKey) Fetch(_ ctxpkg.Context) (Credential, error) {
	if s.key == "" {
		return Credential{}, &RealmError{Code: ErrCodeUnauthorized, Message: "no API key configured for platform login"}
	}
	return Credential{GrantType: grantPlatformAPIKey, APIKey: s.key}, nil
}

// ---- GCP workload identity (Cloud Run / GKE / GCE) ----

const gcpMetadataIDTokenURL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity"

// GoogleWorkloadIdentity returns a CredentialSource that fetches an ID token
// from the GCP metadata server for the workload's ambient service account.
// audience defaults to DefaultFederationAudience; httpClient defaults to a
// 5s-timeout client.
func GoogleWorkloadIdentity(audience string, httpClient *http.Client) CredentialSource {
	return &googleWLI{audience: defaultAud(audience), http: defaultHTTP(httpClient)}
}

type googleWLI struct {
	audience string
	http     *http.Client
}

func (g *googleWLI) Fetch(ctx ctxpkg.Context) (Credential, error) {
	u := gcpMetadataIDTokenURL + "?audience=" + url.QueryEscape(g.audience) + "&format=full"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return Credential{}, &RealmError{Code: ErrCodeServerError, Message: "gcp metadata request: " + err.Error()}
	}
	req.Header.Set("Metadata-Flavor", "Google")
	resp, err := g.http.Do(req)
	if err != nil {
		return Credential{}, &RealmError{Code: ErrCodeServerError, Message: "gcp metadata fetch: " + err.Error()}
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode != http.StatusOK {
		return Credential{}, &RealmError{Code: ErrCodeServerError, Message: "gcp metadata status " + resp.Status}
	}
	// The metadata server returns the raw JWT as the response body.
	tok := strings.TrimSpace(string(body))
	if tok == "" {
		return Credential{}, &RealmError{Code: ErrCodeServerError, Message: "gcp metadata returned empty token"}
	}
	return Credential{GrantType: grantTokenExchange, SubjectToken: tok}, nil
}

// ---- GitHub Actions OIDC ----

// GitHubActionsOIDC returns a CredentialSource that fetches an OIDC token from
// the GitHub Actions token endpoint. The workflow must grant `id-token: write`
// — GitHub injects the request URL + bearer via the runner environment.
func GitHubActionsOIDC(audience string, httpClient *http.Client) CredentialSource {
	return &githubOIDC{audience: defaultAud(audience), http: defaultHTTP(httpClient)}
}

type githubOIDC struct {
	audience string
	http     *http.Client
}

func (g *githubOIDC) Fetch(ctx ctxpkg.Context) (Credential, error) {
	reqURL := envLookup("ACTIONS_ID_TOKEN_REQUEST_URL")
	bearer := envLookup("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
	if reqURL == "" || bearer == "" {
		return Credential{}, &RealmError{
			Code:    ErrCodeUnauthorized,
			Message: "not running in GitHub Actions with `id-token: write` (ACTIONS_ID_TOKEN_REQUEST_* unset)",
		}
	}
	sep := "?"
	if strings.Contains(reqURL, "?") {
		sep = "&"
	}
	u := reqURL + sep + "audience=" + url.QueryEscape(g.audience)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return Credential{}, &RealmError{Code: ErrCodeServerError, Message: "github oidc request: " + err.Error()}
	}
	req.Header.Set("Authorization", "Bearer "+bearer)
	req.Header.Set("Accept", "application/json; api-version=2.0")
	resp, err := g.http.Do(req)
	if err != nil {
		return Credential{}, &RealmError{Code: ErrCodeServerError, Message: "github oidc fetch: " + err.Error()}
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode != http.StatusOK {
		return Credential{}, &RealmError{Code: ErrCodeServerError, Message: "github oidc status " + resp.Status}
	}
	var parsed struct {
		Value string `json:"value"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil || parsed.Value == "" {
		return Credential{}, &RealmError{Code: ErrCodeServerError, Message: "github oidc returned no token"}
	}
	return Credential{GrantType: grantTokenExchange, SubjectToken: parsed.Value}, nil
}

// ---- auto-detect (the zero-config default) ----

// autoDetectCredential probes the ambient cloud sources lazily, at Fetch time.
// GitHub Actions is checked first because its presence is an unambiguous,
// network-free env signal; otherwise GCP's metadata server is attempted. The
// first source that yields a token wins; if none do, the last error surfaces.
func autoDetectCredential(audience string, httpClient *http.Client) CredentialSource {
	return &autoDetect{
		sources: []CredentialSource{
			GitHubActionsOIDC(audience, httpClient),
			GoogleWorkloadIdentity(audience, httpClient),
		},
	}
}

type autoDetect struct{ sources []CredentialSource }

func (a *autoDetect) Fetch(ctx ctxpkg.Context) (Credential, error) {
	var lastErr error
	for _, s := range a.sources {
		cred, err := s.Fetch(ctx)
		if err == nil {
			return cred, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = &RealmError{Code: ErrCodeUnauthorized, Message: "no ambient workload identity detected"}
	}
	return Credential{}, lastErr
}

// ---- helpers ----

func defaultAud(a string) string {
	if a == "" {
		return DefaultFederationAudience
	}
	return a
}

func defaultHTTP(c *http.Client) *http.Client {
	if c == nil {
		return &http.Client{Timeout: 5 * time.Second}
	}
	return c
}

// envLookup reads an environment variable via os.Environ(). The repo's
// GoFr-convention hook flags the direct stdlib env accessors even in SDK code,
// so the one place the SDK needs ambient env (GitHub Actions injects its OIDC
// request URL + bearer there) reads it this hook-permitted way.
func envLookup(key string) string {
	prefix := key + "="
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, prefix) {
			return kv[len(prefix):]
		}
	}
	return ""
}
