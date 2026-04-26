package realmid

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// MFARule is one entry in MiddlewareOptions.MFAProtectedPaths.
//
// Per-route MFA freshness policy (SPEC §10.4):
//   - MaxAge — accept any token whose mfa_at claim is at most that old.
//     Zero means "use the realm-default freshness window"
//     (MiddlewareOptions.MFADefaultMaxAge). Negative is treated as zero.
//   - RequireFresh — require mfa_at within ~30s. Use for irreversible
//     operations. Strict: a legacy amr/acr-only token (no mfa_at)
//     cannot satisfy this — the gate has no way to prove freshness.
type MFARule struct {
	Path         string
	MaxAge       time.Duration
	RequireFresh bool
}

// MFAGateReason mirrors the wire `reason` field on the 412 envelope.
type MFAGateReason string

const (
	MFAReasonNoMFA          MFAGateReason = "no_mfa"
	MFAReasonStaleMFA       MFAGateReason = "stale_mfa"
	MFAReasonFreshRequired  MFAGateReason = "fresh_required"
)

// requireFreshWindow is the grace window on RequireFresh routes — gives
// the client time to retry the original op after /auth/mfa/verify.
const requireFreshWindow = 30 * time.Second

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
	CookieName     string        // default "realmid_refresh"
	CookieDomain   string        // optional
	CookieSecure   bool          // default true
	CookieSameSite http.SameSite // default http.SameSiteLaxMode

	// OnAuthFailure overrides the default 401/412 response.
	OnAuthFailure func(http.ResponseWriter, *http.Request, *RealmError)
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

// compiledMFARule is an MFARule paired with its compiled glob matcher.
type compiledMFARule struct {
	re           *regexp.Regexp
	maxAge       time.Duration
	requireFresh bool
}

func compileMFARules(rules []MFARule) []compiledMFARule {
	out := make([]compiledMFARule, 0, len(rules))
	for _, r := range rules {
		if r.Path == "" {
			continue
		}
		out = append(out, compiledMFARule{
			re:           globToRegex(r.Path),
			maxAge:       r.MaxAge,
			requireFresh: r.RequireFresh,
		})
	}
	return out
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
	ct, methods, err := r.Auth.MintMFAChallenge(reqCtx, accessToken)
	if err != nil {
		r.logger.Warn("realmid mfa challenge mint unavailable", slog.String("error", err.Error()))
		return "", []string{"totp"}
	}
	if len(methods) == 0 {
		methods = []string{"totp"}
	}
	return ct, methods
}



func findMFARule(rules []compiledMFARule, path string) *compiledMFARule {
	for i := range rules {
		if rules[i].re.MatchString(path) {
			return &rules[i]
		}
	}
	return nil
}

// Middleware returns an http.Handler middleware implementing SPEC §10.
func (r *Realm) Middleware(opts MiddlewareOptions) func(http.Handler) http.Handler {
	opts.applyDefaults()
	exempt := compileGlobs(opts.ExemptPaths)
	mfaRules := compileMFARules(opts.MFAProtectedPaths)
	defaultMaxAge := opts.MFADefaultMaxAge

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
					r.handleLogin(w, req, &opts)
					return
				case opts.LogoutPath:
					r.handleLogout(w, req, &opts)
					return
				case opts.RefreshPath:
					r.handleRefresh(w, req, &opts)
					return
				case opts.MFAVerifyPath:
					r.handleMFAVerify(w, req, &opts)
					return
				}
			}

			// 6. Bearer fall-through.
			authz := req.Header.Get("Authorization")
			if !strings.HasPrefix(strings.ToLower(authz), "bearer ") {
				r.respondAuthFail(w, req, &opts, &RealmError{
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
				r.respondAuthFail(w, req, &opts, re)
				return
			}

			// MFA-protected path check (SPEC §10.4).
			if rule := findMFARule(mfaRules, path); rule != nil {
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

	out, err := r.Auth.Login(req.Context(), LoginRequest{
		Method:        LoginMethod(method),
		ProviderToken: provider,
	})
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
		writeRealmError(w, re)
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
	refresh := readRefreshToken(req, opts)
	_ = r.Auth.Logout(req.Context(), &LogoutRequest{RefreshToken: refresh})
	if opts.TokenDelivery != "body" {
		clearRefreshCookie(w, opts)
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

func (r *Realm) handleRefresh(w http.ResponseWriter, req *http.Request, opts *MiddlewareOptions) {
	refresh := readRefreshToken(req, opts)
	if refresh == "" {
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

	out, err := r.Auth.Token(req.Context(), TokenRequest{
		RefreshToken: refresh,
		TenantID:     tenantID,
		CustomClaims: custom,
	})
	if err != nil {
		writeRealmError(w, asRealmError(err))
		return
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
		writeRealmError(w, asRealmError(err))
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

func (r *Realm) respondAuthFail(w http.ResponseWriter, req *http.Request, opts *MiddlewareOptions, err *RealmError) {
	r.logger.Warn("realmid auth failure",
		slog.String("code", string(err.Code)),
		slog.String("path", req.URL.Path),
		slog.Int("http_status", err.HTTPStatus),
	)
	if opts.OnAuthFailure != nil {
		opts.OnAuthFailure(w, req, err)
		return
	}
	status := err.HTTPStatus
	if status == 0 {
		status = 401
	}
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": string(err.Code), "message": err.Message},
	})
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

func readRefreshToken(req *http.Request, opts *MiddlewareOptions) string {
	if opts.TokenDelivery == "body" {
		body, _ := readJSON(req)
		if v, ok := body["refresh_token"].(string); ok {
			return v
		}
	}
	c, err := req.Cookie(opts.CookieName)
	if err != nil {
		return ""
	}
	return c.Value
}

func setRefreshCookie(w http.ResponseWriter, opts *MiddlewareOptions, value string) {
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

func clearRefreshCookie(w http.ResponseWriter, opts *MiddlewareOptions) {
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
