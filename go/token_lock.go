package realmid

// AuthClient.Token under the per-session refresh lock (SPEC §4.2, go 0.64.2).
// It follows handleRefresh's single-flight semantics (SPEC §10.1 step 4a): the
// winner of refreshLockKey(refreshToken) looks for a stored outcome, else mints
// and stores its outcome; a loser waits and adopts it.

import (
	ctxpkg "context"
	"encoding/json"
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
// carrying the newest token in Details["refresh_token"]. The issuer call runs
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
	return nil, &RealmError{
		Code: ErrCodeServerError, Message: "refresh superseded, retry", HTTPStatus: http.StatusServiceUnavailable,
		Details: map[string]any{"refresh_token": req.RefreshToken},
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
		if oc = r.loadOutcome(ctx, key); oc != nil && !tokenOutcomeUsable(oc, fp, key) {
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
		return nil, "", oc.Err.realmError()
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

func tokenOutcomeUsable(oc *refreshOutcome, fp, key string) bool {
	if oc.Err != nil || oc.Fingerprint == fp {
		return true
	}
	return oc.Mint != nil && oc.Mint.RefreshToken != "" && oc.Mint.RefreshToken != key
}
