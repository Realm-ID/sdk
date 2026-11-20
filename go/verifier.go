package realmid

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
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

// UnmarshalJSON reads a kid that is present but not a JSON string as absent
// (SPEC §2): such a key is skipped, it does not fail the set.
func (j *jwk) UnmarshalJSON(b []byte) error {
	type plain jwk
	aux := struct {
		*plain
		Kid json.RawMessage `json:"kid"`
	}{plain: (*plain)(j)}
	if err := json.Unmarshal(b, &aux); err != nil {
		return err
	}
	j.Kid = ""
	var kid string
	if json.Unmarshal(aux.Kid, &kid) == nil {
		j.Kid = kid
	}
	return nil
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
	// attempts is the last fetch attempt per realm, success or failure.
	attempts map[string]jwksAttempt

	// flights is the in-flight JWKS fetch per realm; guarded by mu.
	flights map[string]*jwksFlight
	// fetchCap bounds a shared fetch; zero means jwksFetchCap.
	fetchCap time.Duration
}

// jwksFlight is one in-flight JWKS fetch shared by every caller that needs it.
type jwksFlight struct {
	done chan struct{}
	set  map[string]*rsa.PublicKey
	err  *RealmError
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

		attempts: make(map[string]jwksAttempt),
		flights:  make(map[string]*jwksFlight),
	}
}

// Verify parses, signature-verifies, and claim-checks a Realm-ID JWT.
func (v *verifier) Verify(ctx context.Context, token string, opts *VerifyOptions) (*Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, v.fail(ErrCodeMalformed, "expected 3 dot-separated parts")
	}
	hdrBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, v.fail(ErrCodeMalformed, "header b64: %v", err)
	}
	var hdr struct {
		Alg string  `json:"alg"`
		Typ *string `json:"typ"`
		Kid string  `json:"kid"`
	}
	if err := json.Unmarshal(hdrBytes, &hdr); err != nil {
		return nil, v.fail(ErrCodeMalformed, "header json: %v", err)
	}
	// JSON `null` decodes into a struct without error; it is not an object.
	if strings.TrimSpace(string(hdrBytes)) == "null" {
		return nil, v.fail(ErrCodeMalformed, "header json: not an object")
	}
	if hdr.Alg != "RS256" {
		return nil, v.fail(ErrCodeWrongAlgorithm, "unexpected alg: %s", hdr.Alg)
	}
	// SPEC §5.1.1: only an access token verifies. Before the kid lookup so a
	// wrongly typed token never triggers a JWKS fetch.
	if !accessTokenTyp(hdr.Typ) {
		typ := "<absent>"
		if hdr.Typ != nil {
			typ = *hdr.Typ
		}
		return nil, v.failMalformed401("unexpected token type: %s", typ)
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
	// SPEC4_2_claim_fold: refuse fold collisions before any decode binds a key.
	if err := checkClaimFold(payload); err != nil {
		return nil, v.fail(ErrCodeMalformed, "claim fold: %v", err)
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
	// SPEC §5: iss must start with ${issuerUrl}/${realmId}. Checked before any
	// key is resolved, so a token naming another realm never triggers a JWKS
	// fetch for that realm. Only the received iss is named.
	if !strings.HasPrefix(claims.Issuer, v.realm.issuerURL+"/") || realmID != v.realm.realmID {
		return nil, v.fail(ErrCodeWrongIssuer, "iss mismatch: %s", claims.Issuer)
	}

	pub, kerr := v.resolveKey(ctx, realmID, hdr.Kid)
	if kerr != nil {
		if errors.Is(kerr.Cause, context.Canceled) || errors.Is(kerr.Cause, context.DeadlineExceeded) {
			// The caller's own cancellation reaches it intact, so errors.Is sees it.
			return nil, kerr
		}
		return nil, v.fail(kerr.Code, "%s", kerr.Message)
	}

	signedInput := []byte(parts[0] + "." + parts[1])
	sum := sha256.Sum256(signedInput)
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], sig); err != nil {
		return nil, v.fail(ErrCodeBadSignature, "signature invalid")
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
	// SPEC §5.1 / §5.1.1: after the cryptography, before every cache.
	if _, hasEvents := raw["events"]; hasEvents {
		return nil, v.failMalformed401("token carries an events claim")
	}
	if blankSub(claims.Subject) {
		return nil, v.failMalformed401("sub missing or blank")
	}
	// ADR-041 follow-up: shared revocation cache check. Runs AFTER signature
	// + claim verification so a junk JTI never reaches the cache. Opt-in:
	// nil cache → no-op. Cache errors fail closed (request rejected) so
	// partner-supplied caches with reliability issues degrade safely.
	// Keyed on the session key AND, when it differs, the jti: the SDK writes
	// the session key, but a partner that calls Revoke(claims.JWTID, …) itself
	// (the pre-0.63 documented use) must stay effective once sid != jti.
	if v.realm.revocation != nil {
		keys := []string{claims.SessionKey()}
		if claims.JWTID != "" && claims.JWTID != keys[0] {
			keys = append(keys, claims.JWTID)
		}
		for _, k := range keys {
			if k == "" {
				continue
			}
			revoked, rerr := v.realm.revocation.IsRevoked(ctx, k)
			if rerr != nil {
				return nil, v.fail(ErrCodeUnauthorized, "revocation cache: %v", rerr)
			}
			if revoked {
				return nil, v.fail(ErrCodeUnauthorized, "token revoked")
			}
		}
	}
	// ADR-107: subject-keyed authority check. Runs after the jti denylist and
	// under the same fail-closed posture. Opt-in: nil cache → no-op.
	//
	// `iat` is compared, never `exp`: exp moves with the realm's
	// access_ttl_seconds, so a realm that changed its token lifetime would have
	// the comparison silently misjudge which tokens predate the change.
	if v.realm.authority != nil && claims.Subject != "" {
		notBefore, found, aerr := v.realm.authority.StaleSince(ctx, claims.Subject)
		if aerr != nil {
			// Fail closed — but as `unauthorized`, deliberately NOT as
			// token_stale. Answering token_stale on a cache OUTAGE would tell
			// every client to refresh at once, which is C5's loop with an
			// unrelated dependency as the trigger.
			return nil, v.fail(ErrCodeUnauthorized, "authority cache: %v", aerr)
		}
		// A plain `iat < notBefore`: the clock-skew allowance is applied once,
		// when the marker is stamped, and `leeway` never enters this check.
		if found && claims.IssuedAt < notBefore.Unix() {
			return nil, v.failStale()
		}
		// A token with no `iat` cannot be shown to postdate the marker, so it
		// is refused for as long as one stands. The issuer always mints `iat`;
		// this is the fail-closed branch, not a live path.
		if found && claims.IssuedAt == 0 {
			return nil, v.failStale()
		}
	}
	return claims, nil
}

// failStale builds the ADR-107 D10 refusal. The HTTP status is set HERE rather
// than left to the middleware's default, so a partner verifying tokens by hand
// (no SDK middleware in the path) still gets the 401 the contract promises.
func (v *verifier) failStale() error {
	err := v.fail(ErrCodeTokenStale, "token minted before the subject's authority changed")
	var re *RealmError
	if errors.As(err, &re) {
		re.HTTPStatus = http.StatusUnauthorized
	}
	return err
}

func (v *verifier) fail(code ErrorCode, format string, args ...any) error {
	err := newErr(code, format, args...)
	// SPEC §3.1: every `malformed` verifier error carries 401. One choke
	// point, so a new malformed path cannot omit it.
	if code == ErrCodeMalformed {
		err.HTTPStatus = http.StatusUnauthorized
	}
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
	// ADR-064: audience is the platform-intrinsic `realmid:<public_ref>` value,
	// always populated. The legacy fallback to the mutable routing domain is
	// removed — domain is informational only and must never decide `aud`.
	if info.Audience == "" {
		return "", &RealmError{Code: ErrCodeWrongAudience, Message: "audience auto-discovery returned empty"}
	}
	return info.Audience, nil
}

func (v *verifier) resolveKey(ctx context.Context, realmID, kid string) (*rsa.PublicKey, *RealmError) {
	if v.realm.split != nil {
		// SPEC §14.4 / R39: a split realm never consults RealmID's JWKS.
		return v.realm.split.publicKey(ctx, kid)
	}
	if k, hit := v.cachedKey(realmID, kid); hit {
		return k, nil
	}

	if err := ctx.Err(); err != nil {
		// The caller's own cancellation is returned to it alone: no flight starts, no window.
		return nil, &RealmError{Code: ErrCodeJWKSFetchFailed, Message: "fetch jwks: " + err.Error(), Cause: err}
	}

	v.mu.Lock()
	// The set may have been refreshed since the lock-free read above.
	if k, hit := v.cachedKeyLocked(realmID, kid); hit {
		v.mu.Unlock()
		return k, nil
	}
	f := v.flights[realmID]
	if f == nil {
		// The window gates only the refetch a kid missing from a still-fresh
		// set triggers: inside it the caller gets the last answer without a
		// new outbound call. A refetch because the set expired, or none was
		// ever fetched, is never refused by it.
		cached := v.cache[realmID]
		last, attempted := v.attempts[realmID]
		setFresh := cached != nil && v.now().Sub(cached.fetchedAt) < jwksTTL
		if setFresh && attempted && v.now().Sub(last.at) < jwksUnknownKidInterval {
			v.mu.Unlock()
			if last.err != nil {
				return nil, last.err
			}
			return nil, newErr(ErrCodeUnknownKID, "kid %s not in JWKS", kid)
		}
		f = &jwksFlight{done: make(chan struct{})}
		v.flights[realmID] = f
		go v.runFlight(ctx, realmID, f)
	}
	v.mu.Unlock()

	// Every caller, the one that started the fetch included, waits only until
	// its own cancellation.
	select {
	case <-f.done:
	case <-ctx.Done():
		err := ctx.Err()
		return nil, &RealmError{Code: ErrCodeJWKSFetchFailed, Message: "fetch jwks: " + err.Error(), Cause: err}
	}
	if f.err != nil {
		return nil, f.err
	}
	k, hasKid := f.set[kid]
	if !hasKid {
		return nil, newErr(ErrCodeUnknownKID, "kid %s not in JWKS", kid)
	}
	return k, nil
}

// jwksFetchCap bounds a shared JWKS fetch whatever the configured client's own
// timeout is (SPEC §2).
const jwksFetchCap = 30 * time.Second

// runFlight performs the realm's one shared fetch, detached from every
// caller's cancellation, and records its outcome once: the window start, the
// cached set or the error. It never holds mu across the HTTP call.
func (v *verifier) runFlight(ctx context.Context, realmID string, f *jwksFlight) {
	limit := v.fetchCap
	if limit <= 0 {
		limit = jwksFetchCap
	}
	fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), limit)
	defer cancel()
	keys, err := v.fetchJWKSRecovered(fctx, realmID)

	v.mu.Lock()
	v.attempts[realmID] = jwksAttempt{at: v.now(), err: err}
	if err == nil {
		v.cache[realmID] = &cachedJWKS{keys: keys, fetchedAt: v.now()}
	}
	f.set, f.err = keys, err
	delete(v.flights, realmID)
	v.mu.Unlock()
	close(f.done)
}

// fetchJWKSRecovered is fetchJWKS for the detached flight goroutine: net/http
// recovers a panic on a request goroutine but not on this one, so a panic is
// turned into the flight's error rather than killing the process.
func (v *verifier) fetchJWKSRecovered(ctx context.Context, realmID string) (keys map[string]*rsa.PublicKey, err *RealmError) {
	defer func() {
		if r := recover(); r != nil {
			keys, err = nil, newErr(ErrCodeJWKSFetchFailed, "fetch jwks: panic: %v", r)
		}
	}()
	return v.fetchJWKS(ctx, realmID)
}

const jwksTTL = 10 * time.Minute

// jwksUnknownKidInterval is the shortest gap between two JWKS fetches that an
// unknown kid may trigger (SPEC §2).
const jwksUnknownKidInterval = 5 * time.Second

// jwksAttempt is the most recent JWKS fetch attempt for a realm and its result.
type jwksAttempt struct {
	at  time.Time
	err *RealmError
}

// cachedKey reads the cache; hit means the key is present and within the TTL.
func (v *verifier) cachedKey(realmID, kid string) (*rsa.PublicKey, bool) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	return v.cachedKeyLocked(realmID, kid)
}

// cachedKeyLocked is cachedKey for a caller already holding mu.
func (v *verifier) cachedKeyLocked(realmID, kid string) (*rsa.PublicKey, bool) {
	cached, ok := v.cache[realmID]
	if !ok || v.now().Sub(cached.fetchedAt) >= jwksTTL {
		return nil, false
	}
	k, has := cached.keys[kid]
	return k, has
}

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
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, newErr(ErrCodeJWKSFetchFailed, "jwks fetch returned %d: %s", resp.StatusCode, string(body))
	}
	var doc jwksDoc
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return nil, newErr(ErrCodeJWKSFetchFailed, "decode jwks: %v", err)
	}
	out := make(map[string]*rsa.PublicKey, len(doc.Keys))
	for _, j := range doc.Keys {
		if j.Kty != "RSA" || j.Kid == "" {
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
		n := new(big.Int).SetBytes(nBytes)
		e := new(big.Int).SetBytes(eBytes)
		if n.Sign() == 0 || e.Sign() == 0 || !e.IsInt64() || e.Int64() > math.MaxInt32 {
			return nil, newErr(ErrCodeJWKSFetchFailed, "unusable key material for kid %s", j.Kid)
		}
		out[j.Kid] = &rsa.PublicKey{N: n, E: int(e.Int64())}
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
