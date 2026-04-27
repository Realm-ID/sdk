package realmid

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
)

// VerifyOptions is the per-call override surface for Verify.
type VerifyOptions struct {
	// Audience overrides the auto-discovered audience for this call only.
	Audience string
}

// jwk is one entry in /{realm}/.well-known/jwks.json.
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

// cachedJWKS is one realm's currently-cached key set.
type cachedJWKS struct {
	keys      map[string]*rsa.PublicKey
	fetchedAt time.Time
}

// verifier holds the JWKS cache for the parent Realm handle.
type verifier struct {
	realm  *Realm
	leeway time.Duration
	now    func() time.Time

	mu    sync.RWMutex
	cache map[string]*cachedJWKS // realmID -> keys
}

func newVerifier(r *Realm) *verifier {
	leeway := r.cfg.Leeway
	if leeway == 0 {
		leeway = 30 * time.Second
	}
	now := r.cfg.Clock
	if now == nil {
		now = time.Now
	}
	return &verifier{
		realm:  r,
		leeway: leeway,
		now:    now,
		cache:  make(map[string]*cachedJWKS),
	}
}

// Verify parses, signature-verifies, and claim-checks a Realm-ID JWT.
func (v *verifier) Verify(ctx context.Context, token string, opts *VerifyOptions) (*Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		err := newErr(ErrCodeMalformed, "expected 3 dot-separated parts")
		v.realm.logger.Error("realmid verify failed", slog.String("code", string(err.Code)))
		return nil, err
	}
	hdrBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, v.fail(ErrCodeMalformed, "header b64: %v", err)
	}
	var hdr struct {
		Alg string `json:"alg"`
		Typ string `json:"typ"`
		Kid string `json:"kid"`
	}
	if err := json.Unmarshal(hdrBytes, &hdr); err != nil {
		return nil, v.fail(ErrCodeMalformed, "header json: %v", err)
	}
	if hdr.Alg != "RS256" {
		return nil, v.fail(ErrCodeWrongAlgorithm, "unexpected alg: %s", hdr.Alg)
	}
	if hdr.Kid == "" {
		return nil, v.fail(ErrCodeMalformed, "kid missing from header")
	}

	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, v.fail(ErrCodeMalformed, "payload b64: %v", err)
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, v.fail(ErrCodeMalformed, "sig b64: %v", err)
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(payload, &raw); err != nil {
		return nil, v.fail(ErrCodeMalformed, "payload json: %v", err)
	}
	claims := &Claims{}
	if err := json.Unmarshal(payload, claims); err != nil {
		return nil, v.fail(ErrCodeMalformed, "claims json: %v", err)
	}
	if claims.Issuer == "" {
		return nil, v.fail(ErrCodeMalformed, "iss missing")
	}

	realmID, rerr := extractRealmID(claims.Issuer)
	if rerr != nil {
		return nil, v.fail(rerr.Code, "%s", rerr.Message)
	}

	pub, kerr := v.resolveKey(ctx, realmID, hdr.Kid)
	if kerr != nil {
		return nil, v.fail(kerr.Code, "%s", kerr.Message)
	}

	signedInput := []byte(parts[0] + "." + parts[1])
	sum := sha256.Sum256(signedInput)
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], sig); err != nil {
		return nil, v.fail(ErrCodeBadSignature, "signature invalid")
	}

	issuerPrefix := strings.TrimRight(v.realm.baseURL, "/") + "/"
	if !strings.HasPrefix(claims.Issuer, issuerPrefix) {
		return nil, v.fail(ErrCodeWrongIssuer, "iss mismatch: %s", claims.Issuer)
	}

	expectedAud, audErr := v.expectedAudience(ctx, opts)
	if audErr != nil {
		return nil, audErr
	}
	if claims.Audience != expectedAud {
		return nil, v.fail(ErrCodeWrongAudience, "aud mismatch: %s", claims.Audience)
	}

	now := v.now().Unix()
	leeway := int64(v.leeway.Seconds())
	if claims.Expiry != 0 && now-leeway >= claims.Expiry {
		return nil, v.fail(ErrCodeExpired, "token expired")
	}
	if claims.NotBefore != 0 && now+leeway < claims.NotBefore {
		return nil, v.fail(ErrCodeNotYetValid, "token not yet valid")
	}

	for k, val := range raw {
		if _, reserved := reservedClaimKeys[k]; reserved {
			continue
		}
		var x any
		if err := json.Unmarshal(val, &x); err != nil {
			continue
		}
		if claims.Extra == nil {
			claims.Extra = make(map[string]any)
		}
		claims.Extra[k] = x
	}
	// ADR-041 follow-up: shared revocation cache check. Runs AFTER signature
	// + claim verification so a junk JTI never reaches the cache. Opt-in:
	// nil cache → no-op. Cache errors fail closed (request rejected) so
	// partner-supplied caches with reliability issues degrade safely.
	if v.realm.revocation != nil && claims.JWTID != "" {
		revoked, rerr := v.realm.revocation.IsRevoked(ctx, claims.JWTID)
		if rerr != nil {
			return nil, v.fail(ErrCodeUnauthorized, "revocation cache: %v", rerr)
		}
		if revoked {
			return nil, v.fail(ErrCodeUnauthorized, "token revoked")
		}
	}
	return claims, nil
}

func (v *verifier) fail(code ErrorCode, format string, args ...any) error {
	err := newErr(code, format, args...)
	v.realm.logger.Error("realmid verify failed", slog.String("code", string(code)))
	return err
}

func (v *verifier) expectedAudience(ctx context.Context, opts *VerifyOptions) (string, error) {
	if opts != nil && opts.Audience != "" {
		return opts.Audience, nil
	}
	info, err := v.realm.info.Info(ctx)
	if err != nil {
		return "", &RealmError{Code: ErrCodeWrongAudience, Message: "audience auto-discovery failed: " + err.Error(), Cause: err}
	}
	aud := info.Audience
	if aud == "" {
		aud = info.Domain
	}
	if aud == "" {
		return "", &RealmError{Code: ErrCodeWrongAudience, Message: "audience auto-discovery returned empty"}
	}
	return aud, nil
}

func (v *verifier) resolveKey(ctx context.Context, realmID, kid string) (*rsa.PublicKey, *RealmError) {
	v.mu.RLock()
	cached, ok := v.cache[realmID]
	v.mu.RUnlock()
	if ok {
		if k, hasKid := cached.keys[kid]; hasKid && v.now().Sub(cached.fetchedAt) < jwksTTL {
			return k, nil
		}
	}

	keys, err := v.fetchJWKS(ctx, realmID)
	if err != nil {
		return nil, err
	}
	v.mu.Lock()
	v.cache[realmID] = &cachedJWKS{keys: keys, fetchedAt: v.now()}
	v.mu.Unlock()

	k, hasKid := keys[kid]
	if !hasKid {
		return nil, newErr(ErrCodeUnknownKID, "kid %s not in JWKS", kid)
	}
	return k, nil
}

const jwksTTL = 10 * time.Minute

func (v *verifier) fetchJWKS(ctx context.Context, realmID string) (map[string]*rsa.PublicKey, *RealmError) {
	url := fmt.Sprintf("%s/%s/.well-known/jwks.json", strings.TrimRight(v.realm.baseURL, "/"), realmID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, newErr(ErrCodeJWKSFetchFailed, "build jwks request: %v", err)
	}
	resp, err := v.realm.http.hc.Do(req)
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

func extractRealmID(iss string) (string, *RealmError) {
	idx := strings.LastIndex(iss, "/")
	if idx < 0 || idx == len(iss)-1 {
		return "", newErr(ErrCodeWrongIssuer, "iss has no realm segment")
	}
	return iss[idx+1:], nil
}
