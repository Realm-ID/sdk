// Package realmid is the Go SDK for verifying RealmID-issued JWTs.
//
// Mirror of the TypeScript SDK at @realmid/sdk. Configure once with the
// issuer base URL and your audience; call Verify per request. JWKS is
// fetched per-realm on demand, cached for CacheTTL, and refetched on
// unknown-kid (a key-rotation signal).
//
// Usage:
//
//	v, err := realmid.NewVerifier(realmid.Config{
//	    BaseURL:  "https://auth.realmid.dev",
//	    Audience: "your-partner-audience",
//	})
//	if err != nil { ... }
//	claims, err := v.Verify(token)
//
// Self-contained — depends only on the Go standard library.
package realmid

import (
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ErrorCode is a stable, machine-readable identifier for a verification
// failure. Mirrors the VerifyErrorCode union in the TypeScript SDK.
type ErrorCode string

const (
	ErrCodeMalformed       ErrorCode = "malformed"
	ErrCodeWrongAlgorithm  ErrorCode = "wrong_algorithm"
	ErrCodeBadSignature    ErrorCode = "bad_signature"
	ErrCodeWrongIssuer     ErrorCode = "wrong_issuer"
	ErrCodeWrongAudience   ErrorCode = "wrong_audience"
	ErrCodeExpired         ErrorCode = "expired"
	ErrCodeNotYetValid     ErrorCode = "not_yet_valid"
	ErrCodeUnknownKID      ErrorCode = "unknown_kid"
	ErrCodeJWKSFetchFailed ErrorCode = "jwks_fetch_failed"
)

// Error is the typed error returned from Verify. Callers branch on Code.
type Error struct {
	Code    ErrorCode
	Message string
}

func (e *Error) Error() string {
	return fmt.Sprintf("realmid: %s: %s", e.Code, e.Message)
}

func newErr(code ErrorCode, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Config configures a Verifier. BaseURL and Audience are required.
type Config struct {
	// BaseURL is the issuer host without trailing slash, e.g.
	// "https://auth.realmid.dev". Tokens whose iss does not start with
	// BaseURL+"/" are rejected.
	BaseURL string

	// Audience is the expected aud claim, e.g. your partner identifier.
	Audience string

	// HTTPClient is used to fetch JWKS. Default: http.Client with 5s timeout.
	HTTPClient *http.Client

	// CacheTTL is how long JWKS responses are cached per realm. Default 10m.
	CacheTTL time.Duration

	// Leeway is the clock-skew tolerance for exp/nbf checks. Default 30s.
	Leeway time.Duration

	// Now is a time source override, useful in tests. Default time.Now.
	Now func() time.Time
}

// Claims is the verified token payload. Standard JWT fields plus the
// RealmID-specific extras (azp, tenant_id, role). Unknown fields land in
// Extra.
type Claims struct {
	Issuer          string         `json:"iss,omitempty"`
	Subject         string         `json:"sub,omitempty"`
	Audience        string         `json:"aud,omitempty"`
	IssuedAt        int64          `json:"iat,omitempty"`
	NotBefore       int64          `json:"nbf,omitempty"`
	Expiry          int64          `json:"exp,omitempty"`
	JWTID           string         `json:"jti,omitempty"`
	AuthorizedParty string         `json:"azp,omitempty"`
	TenantID        string         `json:"tenant_id,omitempty"`
	Role            string         `json:"role,omitempty"`
	Extra           map[string]any `json:"-"`
}

// reservedClaimKeys must stay in sync with the Claims struct fields above.
var reservedClaimKeys = map[string]struct{}{
	"iss": {}, "sub": {}, "aud": {}, "iat": {}, "nbf": {}, "exp": {},
	"jti": {}, "azp": {}, "tenant_id": {}, "role": {},
}

// Verifier verifies RealmID JWTs. Safe for concurrent use.
type Verifier struct {
	cfg Config

	mu    sync.RWMutex
	cache map[string]*cachedJWKS // realmID → keys
}

type cachedJWKS struct {
	keys      map[string]*rsa.PublicKey
	fetchedAt time.Time
}

// NewVerifier builds a Verifier. Returns an error if required fields are missing.
func NewVerifier(cfg Config) (*Verifier, error) {
	if cfg.BaseURL == "" {
		return nil, errors.New("realmid: BaseURL required")
	}
	if cfg.Audience == "" {
		return nil, errors.New("realmid: Audience required")
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: 5 * time.Second}
	}
	if cfg.CacheTTL == 0 {
		cfg.CacheTTL = 10 * time.Minute
	}
	if cfg.Leeway == 0 {
		cfg.Leeway = 30 * time.Second
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	cfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")
	return &Verifier{cfg: cfg, cache: make(map[string]*cachedJWKS)}, nil
}

// Verify parses, signature-verifies, and claim-checks a RealmID access token.
func (v *Verifier) Verify(token string) (*Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, newErr(ErrCodeMalformed, "expected 3 dot-separated parts")
	}
	hdrBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, newErr(ErrCodeMalformed, "header b64: %v", err)
	}
	var hdr struct {
		Alg string `json:"alg"`
		Typ string `json:"typ"`
		Kid string `json:"kid"`
	}
	if err := json.Unmarshal(hdrBytes, &hdr); err != nil {
		return nil, newErr(ErrCodeMalformed, "header json: %v", err)
	}
	if hdr.Alg != "RS256" {
		return nil, newErr(ErrCodeWrongAlgorithm, "unexpected alg: %s", hdr.Alg)
	}
	if hdr.Kid == "" {
		return nil, newErr(ErrCodeMalformed, "kid missing from header")
	}

	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, newErr(ErrCodeMalformed, "payload b64: %v", err)
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, newErr(ErrCodeMalformed, "sig b64: %v", err)
	}

	// Decode claims into both the typed struct and a generic map (so we can
	// stash unknown keys into Extra).
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(payload, &raw); err != nil {
		return nil, newErr(ErrCodeMalformed, "payload json: %v", err)
	}
	claims := &Claims{}
	if err := json.Unmarshal(payload, claims); err != nil {
		return nil, newErr(ErrCodeMalformed, "claims json: %v", err)
	}
	if claims.Issuer == "" {
		return nil, newErr(ErrCodeMalformed, "iss missing")
	}

	realmID, rerr := extractRealmID(claims.Issuer)
	if rerr != nil {
		return nil, rerr
	}

	pub, kerr := v.resolveKey(realmID, hdr.Kid)
	if kerr != nil {
		return nil, kerr
	}

	signedInput := []byte(parts[0] + "." + parts[1])
	sum := sha256.Sum256(signedInput)
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], sig); err != nil {
		return nil, newErr(ErrCodeBadSignature, "signature invalid")
	}

	issuerPrefix := v.cfg.BaseURL + "/"
	if !strings.HasPrefix(claims.Issuer, issuerPrefix) {
		return nil, newErr(ErrCodeWrongIssuer, "iss mismatch: %s", claims.Issuer)
	}
	if claims.Audience != v.cfg.Audience {
		return nil, newErr(ErrCodeWrongAudience, "aud mismatch: %s", claims.Audience)
	}

	now := v.cfg.Now().Unix()
	leeway := int64(v.cfg.Leeway.Seconds())
	if claims.Expiry != 0 && now-leeway >= claims.Expiry {
		return nil, newErr(ErrCodeExpired, "token expired")
	}
	if claims.NotBefore != 0 && now+leeway < claims.NotBefore {
		return nil, newErr(ErrCodeNotYetValid, "token not yet valid")
	}

	// Stash unknown keys in Extra.
	for k, v := range raw {
		if _, reserved := reservedClaimKeys[k]; reserved {
			continue
		}
		var val any
		if err := json.Unmarshal(v, &val); err != nil {
			continue
		}
		if claims.Extra == nil {
			claims.Extra = make(map[string]any)
		}
		claims.Extra[k] = val
	}
	return claims, nil
}

func extractRealmID(iss string) (string, *Error) {
	idx := strings.LastIndex(iss, "/")
	if idx < 0 || idx == len(iss)-1 {
		return "", newErr(ErrCodeWrongIssuer, "iss has no realm segment")
	}
	return iss[idx+1:], nil
}

func (v *Verifier) resolveKey(realmID, kid string) (*rsa.PublicKey, *Error) {
	v.mu.RLock()
	cached, ok := v.cache[realmID]
	v.mu.RUnlock()
	if ok {
		if k, hasKid := cached.keys[kid]; hasKid && v.cfg.Now().Sub(cached.fetchedAt) < v.cfg.CacheTTL {
			return k, nil
		}
	}

	keys, err := v.fetchJWKS(realmID)
	if err != nil {
		return nil, err
	}
	v.mu.Lock()
	v.cache[realmID] = &cachedJWKS{keys: keys, fetchedAt: v.cfg.Now()}
	v.mu.Unlock()

	k, hasKid := keys[kid]
	if !hasKid {
		return nil, newErr(ErrCodeUnknownKID, "kid %s not in JWKS", kid)
	}
	return k, nil
}

type jwk struct {
	Kty string `json:"kty"`
	Use string `json:"use,omitempty"`
	Alg string `json:"alg,omitempty"`
	Kid string `json:"kid"`
	N   string `json:"n"`
	E   string `json:"e"`
}

type jwksDoc struct {
	Keys []jwk `json:"keys"`
}

func (v *Verifier) fetchJWKS(realmID string) (map[string]*rsa.PublicKey, *Error) {
	url := fmt.Sprintf("%s/%s/.well-known/jwks.json", v.cfg.BaseURL, realmID)
	resp, err := v.cfg.HTTPClient.Get(url)
	if err != nil {
		return nil, newErr(ErrCodeJWKSFetchFailed, "fetch jwks: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, newErr(ErrCodeJWKSFetchFailed, "jwks fetch returned %d: %s", resp.StatusCode, string(body))
	}
	var doc jwksDoc
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return nil, newErr(ErrCodeJWKSFetchFailed, "decode jwks: %v", err)
	}
	out := make(map[string]*rsa.PublicKey, len(doc.Keys))
	for _, j := range doc.Keys {
		if j.Kty != "RSA" {
			continue
		}
		nBytes, err := base64.RawURLEncoding.DecodeString(j.N)
		if err != nil {
			return nil, newErr(ErrCodeJWKSFetchFailed, "decode n for kid %s: %v", j.Kid, err)
		}
		eBytes, err := base64.RawURLEncoding.DecodeString(j.E)
		if err != nil {
			return nil, newErr(ErrCodeJWKSFetchFailed, "decode e for kid %s: %v", j.Kid, err)
		}
		out[j.Kid] = &rsa.PublicKey{
			N: new(big.Int).SetBytes(nBytes),
			E: int(new(big.Int).SetBytes(eBytes).Int64()),
		}
	}
	return out, nil
}
