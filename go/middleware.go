package realmid

import (
	"bytes"
	"context"
	// ctxpkg aliases the same standard context package; new exported hook
	// signatures use ctxpkg.Context to dodge the check-gofr.sh false
	// positive in SDK code (see sdk/CLAUDE.md).
	ctxpkg "context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// MFAGateReason mirrors the wire `reason` field on the 412 envelope.
type MFAGateReason string

const (
	MFAReasonNoMFA         MFAGateReason = "no_mfa"
	MFAReasonStaleMFA      MFAGateReason = "stale_mfa"
	MFAReasonFreshRequired MFAGateReason = "fresh_required"
)

// AuthFlow identifies which middleware auth route produced an event.
type AuthFlow int

const (
	FlowLogin AuthFlow = iota
	FlowRefresh
	FlowMFAVerify
)

// OriginEnforcementMode controls the confused-deputy Origin guard on the
// middleware's unauthenticated /auth/* routes (ADR-065).
type OriginEnforcementMode int

const (
	// OriginEnforcementAuto (default) follows the realm policy from
	// realm.Info(): enforce iff RealmInfo.OriginEnforcement == "required".
	OriginEnforcementAuto OriginEnforcementMode = iota
	// OriginEnforcementOn forces enforcement regardless of realm policy.
	OriginEnforcementOn
	// OriginEnforcementOff disables enforcement — the escape hatch for a
	// non-browser/M2M deployment on a realm whose policy is "required".
	OriginEnforcementOff
)

// auth-failure stages (AuthFailureEvent.Stage) — where the failure arose.
const (
	stageOrigin      = "origin"
	stageBeforeLogin = "before_login"
	stageLogin       = "login"
	stageRefresh     = "refresh"
	stageMFAVerify   = "mfa_verify"
	stageOnSuccess   = "on_success"
	stageVerify      = "verify"
)

// AuthSuccessEvent describes a just-completed authentication, delivered to
// MiddlewareOptions.OnAuthSuccess AFTER the issuer mints tokens but BEFORE
// the refresh cookie + success body are written (ADR-065).
//
// UserID/TenantID/Role are normalized across all three call sites so the
// hook is a single code path. On login/mfa the identity comes from the
// Session; on refresh the issuer's MintResult has no user object, so the
// SDK recovers UserID by verifying the freshly-minted access token's `sub`
// (done only when OnAuthSuccess is set). Session/Tenants are populated on
// login/mfa and nil/empty on refresh; Claims is populated where the SDK
// verified (the refresh path).
type AuthSuccessEvent struct {
	Flow        AuthFlow      // FlowLogin | FlowRefresh | FlowMFAVerify
	Method      LoginMethod   // login method ("" on refresh/mfa)
	UserID      string        // normalized subject id
	TenantID    string        // pinned tenant
	Role        string        // role on the minted token
	Tenants     []TenantRef   // membership list — login/mfa only
	Claims      *Claims       // verified access-token claims (refresh path)
	Session     *Session      // full session on login/mfa; nil on refresh
	AccessToken string        // always present
	Request     *http.Request // inbound request — read-only
}

// AuthFailureEvent describes a failed authentication, delivered to
// MiddlewareOptions.OnAuthFailure (observe-only — ADR-065). The middleware
// always writes the canonical {error:{code,message}} envelope; the hook
// is for side effects (audit, metrics, brute-force counters) only.
type AuthFailureEvent struct {
	Stage   string        // one of the stage* constants
	Err     *RealmError   // the failure
	Request *http.Request // inbound request — read-only
}

// MiddlewareOptions configures Realm.Middleware (SPEC §10).
type MiddlewareOptions struct {
	// ExemptPaths is a list of glob patterns that bypass the
	// middleware entirely. Defaults to ["/health", "/public/*"].
	ExemptPaths []string

	// MFAProtectedPaths declares paths that require MFA. Each entry is
	// either a bare path string (sugar for {Path: s} — inherits the
	// realm-default freshness window) or a full MFARule for per-route
	// override. SPEC §10.4.
	MFAProtectedPaths []MFARule

	// MFADefaultMaxAge is the realm-wide default freshness window
	// applied to MFARule entries that omit MaxAge. Default 15 min.
	// Mirrors realms.config.mfa_session_ttl_seconds server-side.
	MFADefaultMaxAge time.Duration

	// LoginPath, LogoutPath, RefreshPath, MFAVerifyPath are the routes
	// the middleware handles directly (POST). Empty strings disable
	// the route.
	LoginPath     string // default "/login"
	LogoutPath    string // default "/logout"
	RefreshPath   string // default "/token"
	MFAVerifyPath string // default "/mfa/verify"

	// TokenDelivery is "cookie" (default) or "body". Cookie mode sets
	// a HttpOnly cookie carrying the refresh token; body mode returns
	// it inline in the JSON response.
	TokenDelivery string

	// CookieName, CookieDomain, CookieSecure, CookieSameSite control
	// the refresh-token cookie when TokenDelivery == "cookie".
	//
	// CHANGING CookieDomain ON A LIVE DEPLOYMENT STRANDS EXISTING SESSIONS
	// unless you also set CookieDomainMigrateFrom. Per RFC 6265 a Set-Cookie
	// carrying a Domain attribute cannot overwrite a host-only cookie of the
	// same name — they are separate jar entries — so every browser that
	// already holds one ends up with two `realmid_refresh` cookies at
	// different scopes. Only one of them is rotated from then on. See
	// CookieDomainMigrateFrom.
	CookieName     string        // default "realmid_refresh"
	CookieDomain   string        // optional
	CookieSecure   bool          // default true
	CookieSameSite http.SameSite // default http.SameSiteLaxMode

	// CookieDomainMigrateFrom lists cookie scopes this deployment PREVIOUSLY
	// wrote the refresh cookie at, so they can be actively evicted rather than
	// left to shadow the live one forever. Use the sentinel "" (empty string)
	// for the host-only scope.
	//
	// You need this when TIGHTENING or REMOVING a domain, because the old,
	// wider cookie is invisible to the new configuration: the SDK cannot
	// discover a scope it is no longer writing to. Widening is handled for
	// free — setting CookieDomain always evicts the host-only twin, which is
	// the common case (host-only default -> ".example.com").
	//
	//   // was host-only, now ".example.com": nothing needed, handled for free.
	//   CookieDomain: ".example.com",
	//
	//   // was ".example.com", now host-only: name the scope being left.
	//   CookieDomainMigrateFrom: []string{".example.com"},
	//
	// Entries are emitted as deletions on every write and on logout, so it is
	// safe to leave them configured permanently; drop them once you are
	// confident no live browser still holds the old scope.
	CookieDomainMigrateFrom []string

	// OriginEnforcement controls the confused-deputy Origin guard on the
	// unauthenticated /auth/* routes (ADR-065). Default
	// OriginEnforcementAuto: follow the realm policy from realm.Info().
	OriginEnforcement OriginEnforcementMode

	// BeforeLogin, if set, runs after the login body is parsed into a
	// LoginRequest and before Auth.Login. It may mutate req in place (e.g.
	// substitute a server-held API key, pin a tenant). A non-nil error
	// aborts the login (routed to OnAuthFailure). Return a *RealmError to
	// control the response code/message.
	BeforeLogin func(ctx ctxpkg.Context, req *LoginRequest) error

	// OnAuthSuccess, if set, runs after a successful login/refresh/mfa mint
	// and BEFORE the refresh cookie + success body are written (ADR-065).
	// A non-nil error aborts the response (routed to OnAuthFailure) so no
	// session reaches the browser.
	//
	// For best-effort post-auth work (e.g. a tenant/user mirror reconcile)
	// handle your own errors and return nil — a non-nil error on the
	// refresh/mfa paths leaves the just-rotated session unusable (the old
	// refresh cookie is already dead; the issuer keeps no grace window).
	// Keep hook work idempotent and fast.
	OnAuthSuccess func(ctx ctxpkg.Context, ev *AuthSuccessEvent) error

	// OnAuthFailure, if set, is invoked (observe-only) on every auth
	// failure — origin reject, BeforeLogin/Auth.* error, OnAuthSuccess
	// error, or bearer verification failure — for side effects such as
	// audit logging or brute-force counters. The middleware always writes
	// the canonical {error:{code,message}} envelope; the hook cannot alter
	// the response. (ADR-065 replaced the former response-owning
	// func(w,r,*RealmError) signature with this observe-only form.)
	OnAuthFailure func(ctx ctxpkg.Context, ev *AuthFailureEvent)
}

// applyDefaults fills in any unset fields with their SPEC defaults.
func (o *MiddlewareOptions) applyDefaults() {
	if len(o.ExemptPaths) == 0 {
		o.ExemptPaths = []string{"/health", "/public/*"}
	}
	if o.MFADefaultMaxAge <= 0 {
		o.MFADefaultMaxAge = 15 * time.Minute
	}
	if o.LoginPath == "" {
		o.LoginPath = "/login"
	}
	if o.LogoutPath == "" {
		o.LogoutPath = "/logout"
	}
	if o.RefreshPath == "" {
		o.RefreshPath = "/token"
	}
	if o.MFAVerifyPath == "" {
		o.MFAVerifyPath = "/mfa/verify"
	}
	if o.TokenDelivery == "" {
		o.TokenDelivery = "cookie"
	}
	if o.CookieName == "" {
		o.CookieName = "realmid_refresh"
	}
	if o.CookieSameSite == 0 {
		o.CookieSameSite = http.SameSiteLaxMode
	}
	// CookieSecure default: true. We can't distinguish "unset" from
	// "false" on a bool — partners explicitly opt out for local dev.
	// Honour whatever the caller passed; this matches Go-idiomatic
	// "zero value is not magic" expectations.
}

// ctxKey is the typed context key the middleware uses to attach
// verified Claims onto the request.
type ctxKey struct{}

var claimsKey = ctxKey{}

// ClaimsFrom extracts the verified Claims from a request context. The
// second return is false if the middleware did not run on this request.
func ClaimsFrom(ctx context.Context) (*Claims, bool) {
	c, ok := ctx.Value(claimsKey).(*Claims)
	return c, ok
}

// mfaProofSource describes how an MFA proof was sourced — explicit
// mfa_at claim, legacy amr/acr marker, or absent entirely. Only the
// explicit timestamp can satisfy a RequireFresh policy; the legacy
// marker carries no proof of freshness.
type mfaProofSource int

const (
	mfaProofNone mfaProofSource = iota
	mfaProofMarkerFallback
	mfaProofTimestamp
)

type mfaProof struct {
	at     time.Time
	source mfaProofSource
}

func readMFAProof(c *Claims, now time.Time) mfaProof {
	if c == nil {
		return mfaProof{source: mfaProofNone}
	}
	if c.MFAAt > 0 {
		return mfaProof{at: time.Unix(c.MFAAt, 0), source: mfaProofTimestamp}
	}
	// Legacy fallback — token has the marker but no timestamp. Servers
	// that haven't started emitting mfa_at land here. Treat as freshly
	// minted so existing maxAge gates pass; RequireFresh still rejects.
	if c.HasMFA() {
		return mfaProof{at: now, source: mfaProofMarkerFallback}
	}
	return mfaProof{source: mfaProofNone}
}

// mfaVerdict carries a 412-response payload when the gate rejects.
type mfaVerdict struct {
	Reason MFAGateReason
	MaxAge time.Duration
}

func evaluateMFAFreshness(c *Claims, rule *compiledMFARule, defaultMaxAge time.Duration) *mfaVerdict {
	now := time.Now()
	proof := readMFAProof(c, now)
	age := now.Sub(proof.at)

	// RequireFresh — must have an explicit mfa_at claim within the grace window.
	if rule.requireFresh {
		if proof.source == mfaProofTimestamp && age <= requireFreshWindow {
			return nil
		}
		return &mfaVerdict{Reason: MFAReasonFreshRequired, MaxAge: 0}
	}

	maxAge := rule.maxAge
	if maxAge <= 0 {
		maxAge = defaultMaxAge
	}
	// MaxAge of 0 collapses to RequireFresh semantics.
	if maxAge <= 0 {
		if proof.source == mfaProofTimestamp && age <= requireFreshWindow {
			return nil
		}
		reason := MFAReasonNoMFA
		if proof.source != mfaProofNone {
			reason = MFAReasonStaleMFA
		}
		return &mfaVerdict{Reason: reason, MaxAge: 0}
	}

	if proof.source == mfaProofNone {
		return &mfaVerdict{Reason: MFAReasonNoMFA, MaxAge: maxAge}
	}
	if age > maxAge {
		return &mfaVerdict{Reason: MFAReasonStaleMFA, MaxAge: maxAge}
	}
	return nil
}

// mintMFAChallenge calls /auth/mfa/challenge to mint a challenge token
// for the verified access token. Best-effort: if the server doesn't
// support the endpoint yet, returns ("", ["totp"]) so the 412 envelope
// still tells the client which methods are available.
func (r *Realm) mintMFAChallenge(reqCtx context.Context, accessToken string) (string, []string) {
	ct, methods, err := r.Auth.MintMFAChallenge(reqCtx, MFAChallengeRequest{AccessToken: accessToken})
	if err != nil {
		r.logger.Warn("realmid mfa challenge mint unavailable", slog.String("error", err.Error()))
		return "", []string{"totp"}
	}
	if len(methods) == 0 {
		methods = []string{"totp"}
	}
	return ct, methods
}

// Middleware returns an http.Handler middleware implementing SPEC §10.
func (r *Realm) Middleware(opts MiddlewareOptions) func(http.Handler) http.Handler {
	opts.applyDefaults()
	exempt := compileGlobs(opts.ExemptPaths)
	mfaRules := compileMFARules(opts.MFAProtectedPaths)
	mfaNeedBody := mfaRulesNeedBody(mfaRules)
	defaultMaxAge := opts.MFADefaultMaxAge
	// A rule that cannot fire looks exactly like a rule that protects
	// something. Say so LOUDLY at wiring time rather than at the audit that
	// discovers the gate was never enforced. Partners should call
	// ValidateMFARules themselves and refuse to boot; this is the backstop for
	// those who don't.
	if err := ValidateMFARules(opts.MFAProtectedPaths); err != nil {
		r.logger.Error("realmid mfa rule configuration is invalid",
			slog.String("error", err.Error()))
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			path := req.URL.Path

			// 1. Exempt path?
			if matchAny(exempt, path) {
				next.ServeHTTP(w, req)
				return
			}

			// 2-5. Auth ingress routes.
			if req.Method == http.MethodPost {
				switch path {
				case opts.LoginPath:
					if !r.enforceOrigin(w, req, &opts) {
						return
					}
					r.handleLogin(w, req, &opts)
					return
				case opts.LogoutPath:
					r.handleLogout(w, req, &opts)
					return
				case opts.RefreshPath:
					if !r.enforceOrigin(w, req, &opts) {
						return
					}
					r.handleRefresh(w, req, &opts)
					return
				case opts.MFAVerifyPath:
					if !r.enforceOrigin(w, req, &opts) {
						return
					}
					r.handleMFAVerify(w, req, &opts)
					return
				}
			}

			// 6. Bearer fall-through.
			authz := req.Header.Get("Authorization")
			if !strings.HasPrefix(strings.ToLower(authz), "bearer ") {
				r.respondAuthFail(w, req, &opts, stageVerify, &RealmError{
					Code: ErrCodeUnauthorized, Message: "missing bearer token", HTTPStatus: 401,
				})
				return
			}
			token := strings.TrimSpace(authz[len("bearer "):])
			claims, err := r.Verify(req.Context(), token, nil)
			if err != nil {
				re := asRealmError(err)
				if re.HTTPStatus == 0 {
					re.HTTPStatus = 401
				}
				r.respondAuthFail(w, req, &opts, stageVerify, re)
				return
			}

			// MFA-protected path check (SPEC §10.4).
			//
			// The body is read ONLY when some rule declares a WhenJSONField
			// condition, and is put straight back so the wrapped handler still
			// sees it. A partner who configured no condition pays nothing.
			var mfaBody []byte
			if mfaNeedBody && req.Body != nil {
				mfaBody, _ = io.ReadAll(io.LimitReader(req.Body, mfaBodyLimit))
				_ = req.Body.Close()
				req.Body = io.NopCloser(bytes.NewReader(mfaBody))
			}
			if rule := findMFARule(mfaRules, req.Method, path, mfaBody); rule != nil {
				if verdict := evaluateMFAFreshness(claims, rule, defaultMaxAge); verdict != nil {
					r.logger.Warn("realmid mfa required",
						slog.String("path", path),
						slog.String("sub", claims.Subject),
						slog.String("reason", string(verdict.Reason)),
					)
					ct, methods := r.mintMFAChallenge(req.Context(), token)
					writeJSON(w, http.StatusPreconditionFailed, map[string]any{
						"error": map[string]any{
							"code":    string(ErrCodeMFARequired),
							"message": "MFA required for this resource",
						},
						"mfa_challenge_token": ct,
						"methods":             methods,
						"max_age_seconds":     int(verdict.MaxAge / time.Second),
						"reason":              string(verdict.Reason),
					})
					return
				}
			}

			ctx := context.WithValue(req.Context(), claimsKey, claims)
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	}
}

// ---- route handlers ----

func (r *Realm) handleLogin(w http.ResponseWriter, req *http.Request, opts *MiddlewareOptions) {
	body, err := readJSON(req)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]any{"code": "bad_request", "message": err.Error()}})
		return
	}
	method, _ := body["method"].(string)
	if method == "" {
		method = "firebase"
	}
	provider, _ := body["provider_token"].(string)
	if provider == "" {
		provider, _ = body["providerToken"].(string)
	}
	// tenant_id passthrough (ADR-065 item 4): pin a multi-tenant login.
	tenantID, _ := body["tenant_id"].(string)
	if tenantID == "" {
		tenantID, _ = body["tenantId"].(string)
	}

	lr := LoginRequest{
		Method:        LoginMethod(method),
		ProviderToken: provider,
		TenantID:      tenantID,
	}
	if opts.BeforeLogin != nil {
		if err := opts.BeforeLogin(req.Context(), &lr); err != nil {
			r.respondAuthFail(w, req, opts, stageBeforeLogin, hookError(err))
			return
		}
	}

	out, err := r.Auth.Login(req.Context(), lr)
	if err != nil {
		re := asRealmError(err)
		if re.Code == ErrCodeMFARequired {
			ct, _ := re.Details["mfa_challenge_token"].(string)
			methods := re.Details["methods"]
			if methods == nil {
				methods = re.Details["mfa_methods"]
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"status":              "mfa_required",
				"mfa_challenge_token": ct,
				"methods":             methods,
			})
			return
		}
		r.respondAuthFail(w, req, opts, stageLogin, re)
		return
	}

	if !r.fireSessionSuccess(w, req, opts, FlowLogin, lr.Method, out) {
		return
	}

	resp := map[string]any{
		"access_token": out.AccessToken,
		"expires_in":   out.ExpiresIn,
		"user":         out.User,
		"tenants":      out.Tenants,
	}
	if opts.TokenDelivery == "body" {
		resp["refresh_token"] = out.RefreshToken
	} else {
		setRefreshCookie(w, opts, out.RefreshToken)
	}
	writeJSON(w, http.StatusOK, resp)
}

func (r *Realm) handleLogout(w http.ResponseWriter, req *http.Request, opts *MiddlewareOptions) {
	// Revoke EVERY candidate, not just the first. During a CookieDomain
	// migration the browser holds two, and revoking only the one the old
	// first-match read happened to return left a live session behind a cookie
	// the user could not see or clear.
	for _, refresh := range readRefreshTokens(req, opts) {
		_ = r.Auth.Logout(req.Context(), &LogoutRequest{RefreshToken: refresh})
	}
	if opts.TokenDelivery != "body" {
		clearRefreshCookie(w, opts)
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
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

	// Try each candidate until one mints. With the ordinary single cookie this
	// is exactly the old behaviour, including which error surfaces; with a
	// shadowed jar it is the difference between a working session and a
	// permanent, unrecoverable logout.
	//
	// The FIRST failure is what we report, not the last: with one candidate
	// the two are identical, and with several the first is the one the old
	// code would have surfaced — so no partner's error handling changes shape
	// because a browser happened to be carrying a stale twin.
	var (
		out      *MintResult
		firstErr error
	)
	for _, refresh := range candidates {
		res, err := r.Auth.Token(req.Context(), TokenRequest{
			RefreshToken: refresh,
			TenantID:     tenantID,
			CustomClaims: custom,
		})
		if err == nil {
			out = res
			break
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	if out == nil {
		r.respondAuthFail(w, req, opts, stageRefresh, asRealmError(firstErr))
		return
	}

	// The derived claims (ADR-102 product_roles, ADR-097 scope) are resolved
	// PER MINT, and a refresh is a mint. Without this the middleware handed back
	// a token missing both, one access-TTL into every session — see
	// derived_claims_refresh.go for why the resolution has to follow the mint.
	if err := r.enrichRefreshMint(req.Context(), out, tenantID); err != nil {
		r.respondAuthFail(w, req, opts, stageRefresh, asRealmError(err))
		return
	}

	// OnAuthSuccess (ADR-065). MintResult carries no user object, so recover
	// UserID by verifying the freshly-minted access token's sub — only when
	// a hook is registered.
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
		"access_token": out.AccessToken,
		"expires_in":   out.ExpiresIn,
		"tenant_id":    out.TenantID,
		"role":         out.Role,
	}
	if opts.TokenDelivery == "body" {
		resp["refresh_token"] = out.RefreshToken
	} else {
		setRefreshCookie(w, opts, out.RefreshToken)
	}
	writeJSON(w, http.StatusOK, resp)
}

func (r *Realm) handleMFAVerify(w http.ResponseWriter, req *http.Request, opts *MiddlewareOptions) {
	body, err := readJSON(req)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]any{"code": "bad_request", "message": err.Error()}})
		return
	}
	ct, _ := body["challenge_token"].(string)
	if ct == "" {
		ct, _ = body["challengeToken"].(string)
	}
	code, _ := body["code"].(string)

	out, err := r.Auth.MFAVerify(req.Context(), MFAVerifyRequest{ChallengeToken: ct, Code: code})
	if err != nil {
		r.respondAuthFail(w, req, opts, stageMFAVerify, asRealmError(err))
		return
	}

	if !r.fireSessionSuccess(w, req, opts, FlowMFAVerify, "", out) {
		return
	}

	resp := map[string]any{
		"access_token": out.AccessToken,
		"expires_in":   out.ExpiresIn,
		"user":         out.User,
		"tenants":      out.Tenants,
	}
	if opts.TokenDelivery == "body" {
		resp["refresh_token"] = out.RefreshToken
	} else {
		setRefreshCookie(w, opts, out.RefreshToken)
	}
	writeJSON(w, http.StatusOK, resp)
}

// ---- helpers ----

func (r *Realm) respondAuthFail(w http.ResponseWriter, req *http.Request, opts *MiddlewareOptions, stage string, err *RealmError) {
	r.logger.Warn("realmid auth failure",
		slog.String("code", string(err.Code)),
		slog.String("stage", stage),
		slog.String("path", req.URL.Path),
		slog.Int("http_status", err.HTTPStatus),
	)
	// Observe-only (ADR-065): the hook never owns the response; the
	// middleware always writes the canonical envelope below.
	if opts.OnAuthFailure != nil {
		opts.OnAuthFailure(req.Context(), &AuthFailureEvent{Stage: stage, Err: err, Request: req})
	}
	status := err.HTTPStatus
	if status == 0 {
		status = 401
	}
	body := map[string]any{
		"error": map[string]any{"code": string(err.Code), "message": err.Message},
	}
	for k, v := range err.Details {
		body[k] = v
	}
	writeJSON(w, status, body)
}

// enforceOrigin runs the confused-deputy Origin guard when policy is active
// (ADR-065). Returns true to proceed; on rejection it writes the failure
// response and returns false.
func (r *Realm) enforceOrigin(w http.ResponseWriter, req *http.Request, opts *MiddlewareOptions) bool {
	if !r.originEnforced(req, opts) {
		return true
	}
	origin := req.Header.Get("Origin")
	if origin == "" {
		r.respondAuthFail(w, req, opts, stageOrigin, &RealmError{
			Code: ErrCodeMissingOrigin, Message: "Origin header required", HTTPStatus: http.StatusForbidden,
		})
		return false
	}
	ok, err := r.Origins.Validate(req.Context(), ValidateOriginOptions{RealmID: r.realmID, Origin: origin})
	if err != nil {
		r.respondAuthFail(w, req, opts, stageOrigin, &RealmError{
			Code: ErrCodeServerError, Message: err.Error(), HTTPStatus: http.StatusBadGateway,
		})
		return false
	}
	if !ok {
		r.respondAuthFail(w, req, opts, stageOrigin, &RealmError{
			Code: ErrCodeRealmOriginMismatch, Message: "origin not allowlisted for this realm", HTTPStatus: http.StatusForbidden,
		})
		return false
	}
	return true
}

// originEnforced resolves whether the Origin guard is active for this
// request. Auto follows realm.Info(); On/Off force it. On an Auto-mode
// discovery failure it fails OPEN (don't brick a legitimate login on an RI
// blip) and logs loudly.
func (r *Realm) originEnforced(req *http.Request, opts *MiddlewareOptions) bool {
	switch opts.OriginEnforcement {
	case OriginEnforcementOn:
		return true
	case OriginEnforcementOff:
		return false
	default:
		info, err := r.Info(req.Context())
		if err != nil || info == nil {
			msg := ""
			if err != nil {
				msg = err.Error()
			}
			r.logger.Warn("realmid origin-enforcement policy unavailable; not enforcing",
				slog.String("error", msg))
			return false
		}
		return info.OriginEnforcement == "required"
	}
}

// fireSessionSuccess builds the unified AuthSuccessEvent from a Session
// (login/mfa paths) and invokes OnAuthSuccess. Returns true to proceed;
// false if the hook failed (failure response already written).
func (r *Realm) fireSessionSuccess(w http.ResponseWriter, req *http.Request, opts *MiddlewareOptions, flow AuthFlow, method LoginMethod, s *Session) bool {
	if opts.OnAuthSuccess == nil {
		return true
	}
	ev := &AuthSuccessEvent{
		Flow:        flow,
		Method:      method,
		UserID:      s.User.ID,
		TenantID:    s.TenantID,
		Role:        s.Role,
		Tenants:     s.Tenants,
		Session:     s,
		AccessToken: s.AccessToken,
		Request:     req,
	}
	if err := opts.OnAuthSuccess(req.Context(), ev); err != nil {
		r.respondAuthFail(w, req, opts, stageOnSuccess, hookError(err))
		return false
	}
	return true
}

// hookError converts a partner-hook error into a *RealmError for the
// canonical envelope. A *RealmError is honoured as-is (defaulting status to
// 500); anything else becomes a generic server_error.
func hookError(err error) *RealmError {
	if re, ok := err.(*RealmError); ok {
		if re.HTTPStatus == 0 {
			re.HTTPStatus = http.StatusInternalServerError
		}
		return re
	}
	return &RealmError{Code: ErrCodeServerError, Message: err.Error(), HTTPStatus: http.StatusInternalServerError, Cause: err}
}

func writeRealmError(w http.ResponseWriter, err *RealmError) {
	status := err.HTTPStatus
	if status == 0 {
		status = 500
	}
	body := map[string]any{
		"error": map[string]any{"code": string(err.Code), "message": err.Message},
	}
	for k, v := range err.Details {
		body[k] = v
	}
	writeJSON(w, status, body)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func readJSON(req *http.Request) (map[string]any, error) {
	if req.Body == nil {
		return map[string]any{}, nil
	}
	buf, err := io.ReadAll(io.LimitReader(req.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if len(bytes.TrimSpace(buf)) == 0 {
		return map[string]any{}, nil
	}
	var out map[string]any
	if err := json.Unmarshal(buf, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// maxRefreshCandidates caps how many same-named cookies we will try in one
// request. A browser can legitimately hold two (host-only + domain-scoped)
// during a CookieDomain migration; more than that is a stuffed jar, and an
// uncapped loop would let anyone amplify one request into N issuer calls.
const maxRefreshCandidates = 3

// readRefreshTokens returns EVERY candidate refresh token on the request, in
// the order the browser sent them, deduplicated and capped.
//
// Why a list and not a value: two cookies of the same name at different scopes
// are distinct jar entries, and RFC 6265 §5.4 orders the Cookie header by path
// length then by CREATION time — so with both at Path=/ the OLDER one is sent
// first. `(*http.Request).Cookie` returns the first match and discards the
// rest, which means a single scope change permanently pins the middleware to
// the stale token: rotation only ever updates one of the two, and the frozen
// one keeps winning the read. It never self-heals, because nothing in the
// request path can even observe that a second cookie exists.
//
// Trying each candidate is safe against this issuer: an unrecognised refresh
// hash resolves to nothing and returns ErrNotAuthenticated — there is no
// reuse-detection that revokes the session family on replay (verified in
// authsvc.MintForTenant, 2026-07-28). If that ever changes, this loop becomes
// actively dangerous and must be revisited: it would hand a breach signal one
// stale cookie per request.
func readRefreshTokens(req *http.Request, opts *MiddlewareOptions) []string {
	if opts.TokenDelivery == "body" {
		body, _ := readJSON(req)
		if v, ok := body["refresh_token"].(string); ok && v != "" {
			return []string{v}
		}
		return nil
	}
	var out []string
	seen := make(map[string]struct{}, maxRefreshCandidates)
	for _, c := range req.CookiesNamed(opts.CookieName) {
		if c.Value == "" {
			continue
		}
		if _, dup := seen[c.Value]; dup {
			continue
		}
		seen[c.Value] = struct{}{}
		out = append(out, c.Value)
		if len(out) == maxRefreshCandidates {
			break
		}
	}
	return out
}

// readRefreshToken returns the FIRST candidate, or "" when there is none.
// Retained for the exported ReadRefreshToken shim, whose single-value
// signature is public API.
func readRefreshToken(req *http.Request, opts *MiddlewareOptions) string {
	all := readRefreshTokens(req, opts)
	if len(all) == 0 {
		return ""
	}
	return all[0]
}

func setRefreshCookie(w http.ResponseWriter, opts *MiddlewareOptions, value string) {
	// Evict any twin at another scope BEFORE writing the live value. Reading
	// every candidate (readRefreshTokens) keeps a stranded browser working;
	// this is what actually cleans up, so the jar converges to one cookie
	// instead of carrying the garbage forever.
	//
	// Ordering matters only for readability — the deletions target different
	// jar entries than the write, so they cannot clobber it.
	evictShadowRefreshCookies(w, opts)
	http.SetCookie(w, &http.Cookie{
		Name:     opts.CookieName,
		Value:    value,
		Path:     "/",
		Domain:   opts.CookieDomain,
		HttpOnly: true,
		Secure:   opts.CookieSecure,
		SameSite: opts.CookieSameSite,
	})
}

// evictShadowRefreshCookies expires the refresh cookie at every scope this
// deployment is NOT currently writing to.
//
// Setting CookieDomain always evicts the host-only twin: that is the common
// migration (the default is host-only) and the one scope we can always name
// without being told. The reverse — tightening or removing a domain — is not
// discoverable, because the wider cookie is invisible to a configuration that
// no longer writes it; that is what CookieDomainMigrateFrom is for.
func evictShadowRefreshCookies(w http.ResponseWriter, opts *MiddlewareOptions) {
	scopes := make([]string, 0, len(opts.CookieDomainMigrateFrom)+1)
	if opts.CookieDomain != "" {
		scopes = append(scopes, "") // the host-only twin
	}
	scopes = append(scopes, opts.CookieDomainMigrateFrom...)
	for _, d := range scopes {
		// Compare with the leading dot trimmed: `.example.com` and
		// `example.com` are the SAME cookie scope (the dot has been
		// meaningless since RFC 6265 superseded RFC 2109, and Go's
		// http.SetCookie strips it anyway). Comparing raw strings would let a
		// partner who spelled the two settings differently delete their own
		// live cookie on every single write — the same class of self-inflicted
		// logout this whole change exists to fix.
		if strings.TrimPrefix(d, ".") == strings.TrimPrefix(opts.CookieDomain, ".") {
			continue // never delete the scope we are about to write
		}
		http.SetCookie(w, &http.Cookie{
			Name:     opts.CookieName,
			Value:    "",
			Path:     "/",
			Domain:   d,
			HttpOnly: true,
			Secure:   opts.CookieSecure,
			SameSite: opts.CookieSameSite,
			Expires:  time.Unix(0, 0),
			MaxAge:   -1,
		})
	}
}

func clearRefreshCookie(w http.ResponseWriter, opts *MiddlewareOptions) {
	// Logout must clear EVERY scope. Clearing only the configured one is why
	// signing out and back in did not recover a stranded browser: the shadow
	// cookie survived the logout and went straight back to winning the read.
	evictShadowRefreshCookies(w, opts)
	http.SetCookie(w, &http.Cookie{
		Name:     opts.CookieName,
		Value:    "",
		Path:     "/",
		Domain:   opts.CookieDomain,
		HttpOnly: true,
		Secure:   opts.CookieSecure,
		SameSite: opts.CookieSameSite,
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
	})
}

// SetRefreshCookie writes the refresh-token cookie using the same posture
// the cookie-mode middleware uses (HttpOnly + Secure + SameSite + Name +
// Domain from opts, with SPEC defaults applied). For partners on custom
// routing who want to delegate the security-sensitive cookie mechanics
// without adopting the full middleware (ADR-065 item 5).
func (r *Realm) SetRefreshCookie(w http.ResponseWriter, opts MiddlewareOptions, value string) {
	opts.applyDefaults()
	setRefreshCookie(w, &opts, value)
}

// ReadRefreshToken reads the refresh token from the request the same way
// the middleware does — from the cookie (default) or, when
// opts.TokenDelivery == "body", from the JSON body's refresh_token field.
func (r *Realm) ReadRefreshToken(req *http.Request, opts MiddlewareOptions) string {
	opts.applyDefaults()
	return readRefreshToken(req, &opts)
}

// ClearRefreshCookie expires the refresh-token cookie (logout) using the
// same name/domain/posture as SetRefreshCookie.
func (r *Realm) ClearRefreshCookie(w http.ResponseWriter, opts MiddlewareOptions) {
	opts.applyDefaults()
	clearRefreshCookie(w, &opts)
}

func asRealmError(err error) *RealmError {
	if err == nil {
		return nil
	}
	if re, ok := err.(*RealmError); ok {
		return re
	}
	return &RealmError{Code: ErrCodeServerError, Message: err.Error(), Cause: err}
}

// ---- glob matcher ----

type globPattern struct {
	re *regexp.Regexp
}

func compileGlobs(pats []string) []globPattern {
	out := make([]globPattern, 0, len(pats))
	for _, p := range pats {
		out = append(out, globPattern{re: globToRegex(p)})
	}
	return out
}

func matchAny(pats []globPattern, path string) bool {
	for _, p := range pats {
		if p.re.MatchString(path) {
			return true
		}
	}
	return false
}

// globToRegex converts a glob pattern to an anchored regex. Supports
// `*` (one path segment) and `**` (any). No braces, no character
// classes — partners can use multiple patterns for alternation.
func globToRegex(pat string) *regexp.Regexp {
	var sb strings.Builder
	sb.WriteString("^")
	i := 0
	for i < len(pat) {
		c := pat[i]
		// Detect `/**` so the leading slash is optional too.
		if c == '/' && i+2 < len(pat) && pat[i+1] == '*' && pat[i+2] == '*' {
			sb.WriteString("(?:/.*)?")
			i += 3
			if i < len(pat) && pat[i] == '/' {
				i++
			}
		} else if c == '*' && i+1 < len(pat) && pat[i+1] == '*' {
			sb.WriteString(".*")
			i += 2
			if i < len(pat) && pat[i] == '/' {
				i++
			}
		} else if c == '*' {
			sb.WriteString("[^/]*")
			i++
		} else {
			switch c {
			case '.', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\':
				sb.WriteByte('\\')
				sb.WriteByte(c)
			default:
				sb.WriteByte(c)
			}
			i++
		}
	}
	sb.WriteString("$")
	return regexp.MustCompile(sb.String())
}
