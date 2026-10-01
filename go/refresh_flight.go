package realmid

// Per-session refresh single-flight (SPEC §10.1 step 4a) and the MFA-verify
// lock (step 5). Refresh tokens are one-time-use and reuse revokes the
// session, so two requests presenting one refresh token must not both reach
// the issuer.

import (
	ctxpkg "context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"
)

const (
	// refreshLockTTL is the mint bound (10 s) plus 5 s: the bound starts after the
	// acquire and the stored-outcome read, so an equal TTL lets a full-length mint
	// outlive its lock (SPEC §10.1 step 4a).
	refreshLockTTL       = 15 * time.Second
	storeOutcomeTimeout  = 2 * time.Second
	refreshOutcomeTTL    = 5 * time.Second
	refreshWaitInterval  = 50 * time.Millisecond
	refreshWaitTries     = 60
	defaultMintTimeout   = 10 * time.Second
	mfaVerifyFingerprint = "mfa-verify"
)

// refreshOutcome is what a winner stores under refreshOutcomeKey for losers
// and late presenters. It holds live credentials: the store must treat it as
// a secret.
type refreshOutcome struct {
	Fingerprint string      `json:"fp"`
	Mint        *MintResult `json:"mint,omitempty"`
	Err         *storedErr  `json:"err,omitempty"`
}

type storedErr struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Status  int            `json:"status"`
	Details map[string]any `json:"details,omitempty"`
}

func (s *storedErr) realmError() *RealmError {
	return &RealmError{Code: ErrorCode(s.Code), Message: s.Message, HTTPStatus: s.Status, Details: s.Details}
}

// refreshFingerprint is tenant_id plus the canonical JSON of custom_claims
// (encoding/json sorts map keys).
func refreshFingerprint(tenantID string, custom map[string]any) string {
	cc, _ := json.Marshal(custom)
	return tenantID + "\x00" + string(cc)
}

func (r *Realm) sleepFor(d time.Duration) {
	if r.refreshSleep != nil {
		r.refreshSleep(d)
		return
	}
	time.Sleep(d)
}

func (r *Realm) mintTimeout() time.Duration {
	if r.refreshMintTimeout > 0 {
		return r.refreshMintTimeout
	}
	return defaultMintTimeout
}

func (r *Realm) loadOutcome(ctx ctxpkg.Context, key string) *refreshOutcome {
	raw, ok, err := r.cfg.SessionStore.GetRefreshResult(ctx, refreshOutcomeKey(key))
	if err != nil || !ok {
		return nil
	}
	var oc refreshOutcome
	if json.Unmarshal(raw, &oc) != nil {
		return nil
	}
	return &oc
}

// freshCtx is a bounded context detached from ctx's cancellation AND deadline:
// the outcome store, the rotation record and the lock release must complete
// even when the mint's own bound or the client's connection is already gone.
func freshCtx(ctx ctxpkg.Context) (ctxpkg.Context, ctxpkg.CancelFunc) {
	return ctxpkg.WithTimeout(ctxpkg.WithoutCancel(ctx), storeOutcomeTimeout)
}

func (r *Realm) storeOutcome(ctx ctxpkg.Context, key string, oc *refreshOutcome) {
	raw, err := json.Marshal(oc)
	if err != nil {
		return
	}
	ctx, cancel := freshCtx(ctx)
	defer cancel()
	if err := r.cfg.SessionStore.PutRefreshResult(ctx, refreshOutcomeKey(key), raw, refreshOutcomeTTL); err != nil {
		r.logger.Warn("realmid: storing refresh outcome failed", slog.Any("error", err))
	}
}

// waitOutcome polls the store for the winner's outcome: every 50 ms, at most
// 60 tries (3 s). nil means none arrived.
func (r *Realm) waitOutcome(ctx ctxpkg.Context, key string) *refreshOutcome {
	for i := 0; i < refreshWaitTries; i++ {
		if oc := r.loadOutcome(ctx, key); oc != nil {
			return oc
		}
		r.sleepFor(refreshWaitInterval)
	}
	return nil
}

// releaseLock frees the refresh lock on a fresh bounded context (the request's
// may already be cancelled) and reports a failure.
func (r *Realm) releaseLock(req *http.Request, release func(ctxpkg.Context) error) {
	ctx, cancel := freshCtx(req.Context())
	defer cancel()
	if err := release(ctx); err != nil {
		r.logger.Warn("realmid: refresh lock release failed", slog.Any("error", err))
	}
}

func writeServerError(w http.ResponseWriter, message string, retry bool) {
	body := map[string]any{"error": map[string]any{"code": "server_error", "message": message}}
	if retry {
		body["retry"] = true
	}
	writeJSON(w, http.StatusServiceUnavailable, body)
}

// mintRefresh runs the candidate loop and the derived-claims enrichment on a
// context DETACHED from the request and bounded at 10 s, so a client
// disconnect cannot abort a rotation the issuer already performed. It stores
// the outcome (errors too: a loser retrying a consumed refresh would be reuse).
func (r *Realm) mintRefresh(req *http.Request, candidates []string, tenantID string, custom map[string]any, fp string) *refreshOutcome {
	ctx, cancel := ctxpkg.WithTimeout(ctxpkg.WithoutCancel(req.Context()), r.mintTimeout())
	defer cancel()
	var (
		out      *MintResult
		firstErr error
		minter   string
	)
	// With the ordinary single cookie this is exactly the old behaviour; with a
	// shadowed jar it is the difference between a working session and a
	// permanent logout. The FIRST failure is the one reported.
	for _, refresh := range candidates {
		res, err := r.Auth.Token(ctx, TokenRequest{RefreshToken: refresh, TenantID: tenantID, CustomClaims: custom})
		if err == nil {
			out, minter = res, refresh
			break
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	oc := &refreshOutcome{Fingerprint: fp}
	switch {
	case out == nil:
		oc.Err = toStoredErr(asRealmError(firstErr))
	default:
		if err := r.enrichRefreshMint(ctx, out, tenantID); err != nil {
			oc.Err = toStoredErr(asRealmError(err))
			break
		}
		oc.Mint = out
		// Step 4b: record only a refresh that ROTATED the refresh token.
		if out.RefreshToken != "" && out.RefreshToken != minter {
			rctx, rcancel := freshCtx(ctx)
			r.Tokens.RecordRefresh(rctx, out.AccessToken)
			rcancel()
		}
	}
	r.storeOutcome(ctx, candidates[0], oc)
	return oc
}

func toStoredErr(e *RealmError) *storedErr {
	return &storedErr{Code: string(e.Code), Message: e.Message, Status: e.HTTPStatus, Details: e.Details}
}

func (r *Realm) handleRefresh(w http.ResponseWriter, req *http.Request, opts *MiddlewareOptions) {
	candidates := readRefreshTokens(req, opts)
	if len(candidates) == 0 {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": map[string]any{"code": "unauthorized", "message": "refresh token missing"}})
		return
	}
	body, _ := readJSON(req)
	tenantID, _ := body["tenant_id"].(string)
	if tenantID == "" {
		tenantID, _ = body["tenantId"].(string)
	}
	if tenantID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]any{"code": "tenant_required", "message": "tenant_id required"}})
		return
	}
	custom, _ := body["custom_claims"].(map[string]any)
	if custom == nil {
		custom, _ = body["customClaims"].(map[string]any)
	}
	fp := refreshFingerprint(tenantID, custom)
	key := candidates[0]

	acquired, release, err := r.cfg.SessionStore.AcquireRefreshLock(req.Context(), refreshLockKey(key), refreshLockTTL)
	if err != nil {
		r.logger.Warn("realmid: refresh lock failed", slog.Any("error", err))
		writeServerError(w, "session store unavailable", false)
		return
	}
	var oc *refreshOutcome
	if acquired {
		defer r.releaseLock(req, release)
		// A request that lost the previous winner's response (a reload) is
		// answered from the stored outcome, never by a second mint.
		if oc = r.loadOutcome(req.Context(), key); oc == nil {
			oc = r.mintRefresh(req, candidates, tenantID, custom, fp)
		}
	} else if oc = r.waitOutcome(req.Context(), key); oc == nil {
		writeServerError(w, "refresh in progress", false)
		return
	}
	r.respondRefresh(w, req, opts, oc, fp)
}

// respondRefresh answers from an outcome: the winner's own, or one a loser or
// late presenter adopted. OnAuthSuccess runs on every successful response.
func (r *Realm) respondRefresh(w http.ResponseWriter, req *http.Request, opts *MiddlewareOptions, oc *refreshOutcome, fp string) {
	if oc.Err != nil {
		r.respondAuthFail(w, req, opts, stageRefresh, oc.Err.realmError())
		return
	}
	out := oc.Mint
	if out == nil {
		writeServerError(w, "refresh outcome unreadable", false)
		return
	}
	if oc.Fingerprint != fp {
		// Another tenant, other custom_claims, or an MFA-verify winner: this
		// request does not mint. It hands over the winner's ROTATED token so the
		// client's retry is an ordinary winner on that token.
		resp := map[string]any{
			"error": map[string]any{"code": "server_error", "message": "refresh superseded, retry"},
			"retry": true,
		}
		if opts.TokenDelivery == "body" {
			resp["refresh_token"] = out.RefreshToken
		} else {
			setRefreshCookie(w, opts, out.RefreshToken)
		}
		writeJSON(w, http.StatusServiceUnavailable, resp)
		return
	}

	if opts.OnAuthSuccess != nil {
		ev := &AuthSuccessEvent{
			Flow:        FlowRefresh,
			TenantID:    out.TenantID,
			Role:        out.Role,
			AccessToken: out.AccessToken,
			Request:     req,
		}
		if claims, verr := r.Verify(req.Context(), out.AccessToken, nil); verr == nil && claims != nil {
			ev.UserID = claims.Subject
			ev.Claims = claims
		}
		if herr := opts.OnAuthSuccess(req.Context(), ev); herr != nil {
			r.respondAuthFail(w, req, opts, stageOnSuccess, hookError(herr))
			return
		}
	}

	resp := map[string]any{
		"access_token":     out.AccessToken,
		"expires_in":       out.ExpiresIn,
		"tenant_id":        out.TenantID,
		"role":             out.Role,
		"org_session_mode": r.orgSessionModeOf(req.Context(), out.AccessToken),
	}
	if opts.TokenDelivery == "body" {
		resp["refresh_token"] = out.RefreshToken
	} else {
		setRefreshCookie(w, opts, out.RefreshToken)
	}
	writeJSON(w, http.StatusOK, resp)
}

// lockForMFAVerify takes the refresh lock for an MFA-verify request that
// carries a refresh-token candidate (the issuer's MFA verify ROTATES the
// session's refresh token). It never adopts a refresh outcome — its challenge
// is single-use and not yet consumed — so it WAITS for the lock itself. ok is
// false when a response was already written. key is "" when no lock is taken.
func (r *Realm) lockForMFAVerify(w http.ResponseWriter, req *http.Request, opts *MiddlewareOptions) (key string, release func(), ok bool) {
	candidates := readRefreshTokens(req, opts)
	if len(candidates) == 0 {
		return "", func() {}, true // first-login MFA: no session yet
	}
	key = candidates[0]
	for i := 0; i < refreshWaitTries; i++ {
		acquired, rel, err := r.cfg.SessionStore.AcquireRefreshLock(req.Context(), refreshLockKey(key), refreshLockTTL)
		if err != nil {
			r.logger.Warn("realmid: refresh lock failed", slog.Any("error", err))
			writeServerError(w, "session store unavailable", false)
			return "", nil, false
		}
		if acquired {
			return key, func() { r.releaseLock(req, rel) }, true
		}
		r.sleepFor(refreshWaitInterval)
	}
	writeServerError(w, "refresh in progress", false)
	return "", nil, false
}
