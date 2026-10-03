package realmid

// AuthClient.Token under the per-session refresh lock (SPEC §4.2, go 0.64.2).
// It follows handleRefresh's single-flight semantics (SPEC §10.1 step 4a): the
// winner of refreshLockKey(refreshToken) looks for a stored outcome, else mints
// and stores its outcome; a loser waits and adopts it.

import (
	ctxpkg "context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
)

// tokenMaxHops bounds how many times Token follows a rotated token handed over
// by a winner whose request differed from its own.
const tokenMaxHops = 3

// tokenFingerprint identifies EVERYTHING in the request that shapes the minted
// token. Its "token\x00" prefix is shared with no middleware outcome, so a
// Token caller never adopts (or hands) a token minted for different claims: the
// middleware's refresh outcome is enriched with product roles, a plain Token
// result is not, and crossing them would mint a claim-blind or over-claimed
// token.
func tokenFingerprint(req TokenRequest) string {
	b, _ := json.Marshal(struct {
		Tenant string
		Custom map[string]any
		RolePm any
		Prod   any
		Scope  any
	}{req.TenantID, req.CustomClaims, req.RolePermissions, req.ProductRoles, req.Scope})
	return "token\x00" + string(b)
}

// Token rotates a refresh token, optionally switching tenants and merging custom
// claims into the minted access token.
//
// With a non-empty req.RefreshToken it takes the per-session refresh lock (the
// one the middleware's refresh and MFA routes and a direct MFAVerify given
// RefreshToken take), so concurrent rotations of one session never both reach
// the issuer: a concurrent identical request adopts the winner's result; one
// whose request differs retries on the winner's ROTATED token (never the spent
// one), up to tokenMaxHops, then fails with a retryable 503 server_error
// (a *RefreshSupersededError) carrying the newest token. The issuer call runs
// bounded at the mint timeout on a context detached from ctx's cancellation.
// The lock holds only across replicas sharing one SessionStore; a raw HTTP
// call to the issuer is not covered.
func (a *AuthClient) Token(ctx ctxpkg.Context, req TokenRequest) (*MintResult, error) {
	if req.RefreshToken == "" {
		return a.token(ctx, req)
	}
	// A bad request never spends (and so never rotates away) the token: refuse
	// it before taking the lock.
	if _, err := scopeWireValue(req.Scope); err != nil {
		return nil, err
	}
	for hop := 0; hop < tokenMaxHops; hop++ {
		mr, next, err := a.tokenLockedOnce(ctx, req)
		if err != nil || next == "" {
			return mr, err
		}
		req.RefreshToken = next
	}
	return nil, &RefreshSupersededError{
		re:           &RealmError{Code: ErrCodeServerError, Message: "refresh superseded, retry", HTTPStatus: http.StatusServiceUnavailable},
		refreshToken: req.RefreshToken,
	}
}

// tokenLockedOnce is one winner-or-loser round. next is non-empty when the
// outcome it found was minted for a different request: the caller must retry
// on that rotated token (it is never re-presented the spent one).
func (a *AuthClient) tokenLockedOnce(ctx ctxpkg.Context, req TokenRequest) (mr *MintResult, next string, err error) {
	r := a.realm
	key := req.RefreshToken
	fp := tokenFingerprint(req)
	if cerr := ctx.Err(); cerr != nil {
		return nil, "", cerr
	}
	acquired, release, serr := r.cfg.SessionStore.AcquireRefreshLock(ctx, refreshLockKey(key), refreshLockTTL)
	if serr != nil {
		if cerr := ctx.Err(); cerr != nil {
			return nil, "", cerr
		}
		r.logger.Warn("realmid: refresh lock failed", slog.Any("error", serr))
		return nil, "", &RealmError{Code: ErrCodeServerError, Message: "session store unavailable", HTTPStatus: http.StatusServiceUnavailable, Cause: serr}
	}
	var oc *refreshOutcome
	if acquired {
		defer func() {
			fctx, cancel := freshCtx(ctx)
			defer cancel()
			if rerr := release(fctx); rerr != nil {
				r.logger.Warn("realmid: refresh lock release failed", slog.Any("error", rerr))
			}
		}()
		// An outcome already stored (a repeat inside the window) answers the
		// call, unless it was minted for another request AND did not rotate the
		// token: then there is no spent token to protect and this call mints.
		var lerr error
		if oc, lerr = r.loadOutcome(ctx, key); lerr != nil {
			// Could not find out whether a previous winner already rotated:
			// minting could re-present a spent token. Fail closed.
			r.logger.Warn("realmid: reading refresh outcome failed", slog.Any("error", lerr))
			return nil, "", &RealmError{Code: ErrCodeServerError, Message: "session store unavailable", HTTPStatus: http.StatusServiceUnavailable, Cause: lerr}
		}
		if oc != nil && !tokenOutcomeUsable(oc, fp, key) {
			oc = nil
		}
		if oc == nil {
			wctx, cancel := r.lockedWorkCtx(ctx)
			res, terr := a.token(wctx, req)
			cancel()
			oc = &refreshOutcome{Fingerprint: fp}
			if terr != nil {
				oc.Err = toStoredErr(asRealmError(terr))
			} else {
				oc.Mint = res
			}
			r.storeOutcome(ctx, key, oc) // errors too: a retry of a consumed token is a reuse
		}
	} else if oc = r.waitOutcome(ctx, key); oc == nil {
		if cerr := ctx.Err(); cerr != nil {
			return nil, "", cerr
		}
		return nil, "", &RealmError{Code: ErrCodeServerError, Message: "refresh in progress", HTTPStatus: http.StatusServiceUnavailable}
	}
	if oc.Err != nil {
		if oc.Fingerprint == fp || tokenLevelErr(oc.Err) {
			return nil, "", oc.Err.realmError()
		}
		// Another request's shape-specific failure says nothing about this one.
		// Nothing was rotated by it: go round again on the same token (the lock is
		// free now, so this call mints for itself).
		return nil, key, nil
	}
	if oc.Mint == nil {
		return nil, "", &RealmError{Code: ErrCodeServerError, Message: "refresh outcome unreadable", HTTPStatus: http.StatusServiceUnavailable}
	}
	if oc.Fingerprint != fp {
		// Minted for a different request or by an MFA verify: hand over the
		// rotated token; the caller retries on it as an ordinary winner.
		next = oc.Mint.RefreshToken
		if next == "" {
			next = key // a non-rotating class: nothing was spent
		}
		return nil, next, nil
	}
	return oc.Mint, "", nil
}

// RefreshSupersededError is Token's give-up after tokenMaxHops hand-overs: it
// is a retryable 503 server_error (it unwraps to the *RealmError, so IsCode and
// errors.As(&*RealmError) see it) that carries the newest LIVE refresh token for
// the caller's next attempt. The token is a credential, so it lives in an
// unexported field behind RefreshToken() and is redacted from Error(), every
// fmt verb (including %#v) and JSON, which is what a logger reaches.
type RefreshSupersededError struct {
	re           *RealmError
	refreshToken string
}

// RefreshToken returns the newest live refresh token; present it on the next call.
func (e *RefreshSupersededError) RefreshToken() string { return e.refreshToken }

func (e *RefreshSupersededError) Error() string { return e.re.Error() }

// Unwrap exposes the underlying *RealmError (server_error, HTTP 503).
func (e *RefreshSupersededError) Unwrap() error { return e.re }

// Format prints Error() for every verb so no formatting path reaches the token.
func (e *RefreshSupersededError) Format(s fmt.State, _ rune) { _, _ = io.WriteString(s, e.Error()) }

// GoString keeps %#v (and anything using it) from printing the field.
func (e *RefreshSupersededError) GoString() string { return e.Error() }

// MarshalJSON emits the error's code, message and status only.
func (e *RefreshSupersededError) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]any{"code": e.re.Code, "message": e.re.Message, "status": e.re.HTTPStatus})
}

// tokenLevelErr reports whether a stored error is about the refresh token
// ITSELF (dead, expired, revoked, already spent: refresh_invalid or any 401),
// so it is the same for every request shape. Anything else (a 403 for one
// tenant's narrowing, a 400 for bad claims or scope, a 5xx) belongs to the shape
// that produced it and must not be handed to a different request.
func tokenLevelErr(e *storedErr) bool {
	return e.Code == string(ErrCodeRefreshInvalid) || e.Status == http.StatusUnauthorized
}

func tokenOutcomeUsable(oc *refreshOutcome, fp, key string) bool {
	if oc.Err != nil {
		return oc.Fingerprint == fp || tokenLevelErr(oc.Err)
	}
	if oc.Fingerprint == fp {
		return true
	}
	return oc.Mint != nil && oc.Mint.RefreshToken != "" && oc.Mint.RefreshToken != key
}
