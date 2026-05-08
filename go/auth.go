package realmid

import (
	ctxpkg "context"
	"iter"
	"net/url"
	"strings"
)

// AuthClient implements realm.Auth.* per SPEC §4.
type AuthClient struct {
	realm *Realm
}

// LoginMethod is the upstream identity provider for a login call.
// "firebase" and "google" are supported today; others are roadmap.
type LoginMethod string

const (
	LoginFirebase LoginMethod = "firebase"
	LoginGoogle   LoginMethod = "google"
)

// LoginRequest carries the inputs to realm.Auth.Login. Custom claims
// are NOT accepted on login (SPEC §4.1) — refresh-token identity only.
type LoginRequest struct {
	Method        LoginMethod
	ProviderToken string
	Origin        string // optional override of the SDK-derived Origin header

	// TenantID disambiguates when the user is a member of multiple
	// tenants in the realm. When empty and the user has >1 tenants, the
	// auth server returns the tenant list (no tokens) so the caller can
	// re-POST with the chosen tenant_id.
	TenantID string
}

// TenantRef is the abbreviated tenant info embedded in Session.Tenants.
//
// The wire shape uses `tenant_id` (api/internal/authsvc.TenantMembership);
// `id` is accepted as a fallback for older / mocked issuers in tests.
type TenantRef struct {
	ID          string `json:"tenant_id"`
	IDLegacy    string `json:"id,omitempty"`
	Role        string `json:"role"`
	DisplayName string `json:"display_name,omitempty"`
}

// UserSummary is the verified-user payload returned from Login / MFAVerify.
type UserSummary struct {
	ID          string `json:"id"`
	Email       string `json:"email,omitempty"`
	DisplayName string `json:"display_name,omitempty"`
}

// Session is the result of a successful Login or MFA verify.
//
// Login currently returns flat top-level `tenant_id` + `role` (the user's
// pinned tenant after the login resolved); these surface here so
// callers don't have to parse Tenants[]. `User` is populated from the
// access JWT's claims (sub/email) when the wire response omits it.
type Session struct {
	AccessToken  string      `json:"access_token"`
	RefreshToken string      `json:"refresh_token"`
	ExpiresIn    int         `json:"expires_in"`
	ExpiresAt    string      `json:"expires_at,omitempty"`
	TenantID     string      `json:"tenant_id,omitempty"`
	Role         string      `json:"role,omitempty"`
	User         UserSummary `json:"user"`
	Tenants      []TenantRef `json:"tenants"`
}

// TokenRequest is realm.Auth.Token's input — refresh + tenant_id +
// optional access-token customClaims (SPEC §4.2).
type TokenRequest struct {
	RefreshToken string
	TenantID     string
	CustomClaims map[string]any
}

// MintResult is realm.Auth.Token's response.
type MintResult struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	TenantID     string `json:"tenant_id"`
	Role         string `json:"role"`
}

// MFAVerifyRequest carries an MFA challenge response (SPEC §4.3).
type MFAVerifyRequest struct {
	ChallengeToken string
	Code           string
	Method         string // defaults to "totp"
	// OnBehalfOfIP forwards the end-user's IP to the issuer via
	// X-On-Behalf-Of-IP so per-IP rate limits on /auth/mfa/verify see the
	// SPA's IP rather than the BFF's egress (ADR-050 plan §8.2).
	OnBehalfOfIP string
}

// LogoutRequest optionally targets a specific refresh token. If
// RefreshToken is empty, the server uses the cookie / current session.
type LogoutRequest struct {
	RefreshToken string
	// AccessToken, when set, is pushed to the SDK's RevocationCache (if
	// configured) so the JWT's jti is rejected by Verify until natural
	// expiry. Bridges the gap between user logout and the access token's
	// stateless natural expiry per ADR-041 follow-up. The server-side
	// refresh revocation is independent and always happens.
	AccessToken string
}

// SessionInfo is one entry in realm.Auth.ListSessions.
type SessionInfo struct {
	ID         string `json:"id"`
	CreatedAt  string `json:"created_at,omitempty"`
	LastUsedAt string `json:"last_used_at,omitempty"`
	UserAgent  string `json:"user_agent,omitempty"`
	IP         string `json:"ip,omitempty"`
}

// ListSessionsRequest selects the user whose sessions to list and how
// to attest the call.
//
// Exactly one of UserID or UserBearer must be set:
//   - UserID:     BFF mode. The SDK uses its cached platform token as
//                 the bearer and sends X-On-Behalf-Of-User: <UserID>.
//                 Required when realm.config.require_bff_login=true
//                 (ADR-041 §7).
//   - UserBearer: legacy / public-client mode. The user's access JWT
//                 rides as Authorization: Bearer. Subject is read from
//                 the JWT.
//
// OnBehalfOfIP, when set, is forwarded as X-On-Behalf-Of-IP so the
// issuer's per-IP rate limits see the SPA's IP, not the BFF's egress
// (ADR-050 plan §8.2).
type ListSessionsRequest struct {
	UserID       string
	UserBearer   string
	OnBehalfOfIP string
}

// RevokeSessionRequest names the session to revoke and how to attest
// the caller. Auth shape is identical to ListSessionsRequest.
type RevokeSessionRequest struct {
	SessionID    string
	UserID       string
	UserBearer   string
	OnBehalfOfIP string
}

// MFAChallengeRequest mints a step-up challenge for the user identified
// by AccessToken. OnBehalfOfIP, when set, is forwarded as
// X-On-Behalf-Of-IP for per-IP rate-limit attribution on
// /auth/mfa/challenge (ADR-050 plan §8.2).
type MFAChallengeRequest struct {
	AccessToken  string
	OnBehalfOfIP string
}

// Login exchanges a provider token for a realm-scoped session. On a 412
// mfa_required, returns *RealmError{Code: mfa_required} with
// Details["mfa_challenge_token"] populated.
func (a *AuthClient) Login(ctx ctxpkg.Context, req LoginRequest) (*Session, error) {
	tok, err := a.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	headers := map[string]string{}
	origin := req.Origin
	if origin == "" {
		origin = a.realm.cfg.Origin
	}
	if origin == "" {
		// Auto-derive from realm.Info().
		if info, ierr := a.realm.info.Info(ctx); ierr == nil {
			origin = inferOrigin(info)
		}
	}
	if origin != "" {
		headers["Origin"] = origin
	}

	method := req.Method
	if method == "" {
		method = LoginFirebase
	}
	body := map[string]any{
		"realm_id": a.realm.realmID,
		"method":   string(method),
		// Field name is "token" on the wire (see api/internal/httpapi/auth.go
		// loginReq.Token). The SDK historically sent "provider_token";
		// realigning here keeps Auth.Login working when the BFF talks to
		// auth.realmid.dev directly. SDK 0.6.0 will document this.
		"token": req.ProviderToken,
	}
	if req.TenantID != "" {
		body["tenant_id"] = req.TenantID
	}
	var resp Session
	if err := a.realm.http.do(ctx, requestOptions{
		Method:  "POST",
		Path:    "/auth/login",
		Bearer:  tok,
		Body:    body,
		Headers: headers,
	}, &resp); err != nil {
		return nil, err
	}
	// Consolidate the legacy "id" tenant field onto ID for callers that
	// branch on that. (Today's RealmID emits "tenant_id"; older mocked
	// issuers in tests emit "id".)
	for i := range resp.Tenants {
		if resp.Tenants[i].ID == "" && resp.Tenants[i].IDLegacy != "" {
			resp.Tenants[i].ID = resp.Tenants[i].IDLegacy
		}
	}
	// Backfill User.ID from the access token's sub claim — the wire
	// response shape omits a top-level user object today (see
	// api/internal/httpapi/auth.go loginResp). Email/DisplayName fall
	// out of the JWT too when present.
	if resp.User.ID == "" && resp.AccessToken != "" {
		if sub, email, name, perr := peekJWTUserFields(resp.AccessToken); perr == nil {
			resp.User.ID = sub
			if resp.User.Email == "" {
				resp.User.Email = email
			}
			if resp.User.DisplayName == "" {
				resp.User.DisplayName = name
			}
		}
	}
	return &resp, nil
}

// Token rotates a refresh token, optionally switching tenants and
// merging custom claims into the minted access token.
func (a *AuthClient) Token(ctx ctxpkg.Context, req TokenRequest) (*MintResult, error) {
	tok, err := a.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	body := map[string]any{
		"realm_id":      a.realm.realmID,
		"refresh_token": req.RefreshToken,
		"tenant_id":     req.TenantID,
	}
	if len(req.CustomClaims) > 0 {
		body["custom_claims"] = req.CustomClaims
	}
	var resp MintResult
	if err := a.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/auth/token",
		Bearer: tok,
		Body:   body,
	}, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// OTPLoginRequest is the input for AuthClient.OTPLogin (partner OTP
// proposal §3.2.1). RealmID is overridden via the Realm config; pass
// Identifier (email or E.164 phone) + Presented (the OTP value the user
// typed). Returns Session on success; an enumeration-safe
// invalid_credentials on miss.
type OTPLoginRequest struct {
	Identifier string
	Presented  string
	Origin     string
	TenantID   string
}

// MFAVerifyOTPRequest is the input for AuthClient.MFAVerifyOTP (partner
// OTP proposal §3.2.2). The MFA challenge token comes from the prior
// /auth/login response; Presented is the OTP value the user typed.
type MFAVerifyOTPRequest struct {
	MFAToken     string
	Presented    string
	OnBehalfOfIP string
}

// OTPLogin exchanges an identifier + manager-issued OTP for a realm-
// scoped session. Single-factor variant of the partner OTP primitive
// (proposal §3.2.1). Gated server-side by realms.config.otp_login_enabled.
func (a *AuthClient) OTPLogin(ctx ctxpkg.Context, req OTPLoginRequest) (*Session, error) {
	tok, err := a.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	headers := map[string]string{}
	origin := req.Origin
	if origin == "" {
		origin = a.realm.cfg.Origin
	}
	if origin == "" {
		if info, ierr := a.realm.info.Info(ctx); ierr == nil {
			origin = inferOrigin(info)
		}
	}
	if origin != "" {
		headers["Origin"] = origin
	}
	body := map[string]any{
		"realm_id":   a.realm.realmID,
		"method":     "otp_internal",
		"identifier": req.Identifier,
		"presented":  req.Presented,
	}
	if req.TenantID != "" {
		body["tenant_id"] = req.TenantID
	}
	var resp Session
	if err := a.realm.http.do(ctx, requestOptions{
		Method:  "POST",
		Path:    "/auth/login",
		Bearer:  tok,
		Body:    body,
		Headers: headers,
	}, &resp); err != nil {
		return nil, err
	}
	for i := range resp.Tenants {
		if resp.Tenants[i].ID == "" && resp.Tenants[i].IDLegacy != "" {
			resp.Tenants[i].ID = resp.Tenants[i].IDLegacy
		}
	}
	if resp.User.ID == "" && resp.AccessToken != "" {
		if sub, email, name, perr := peekJWTUserFields(resp.AccessToken); perr == nil {
			resp.User.ID = sub
			if resp.User.Email == "" {
				resp.User.Email = email
			}
			if resp.User.DisplayName == "" {
				resp.User.DisplayName = name
			}
		}
	}
	return &resp, nil
}

// MFAVerifyOTP completes an otp_internal second-factor challenge. Same
// response shape as Login. The first-factor login response carries an
// `mfa_challenge_token` and a `methods` list including "otp_internal"
// when the user is enrolled (per-user mfa_methods or per-role
// required_mfa_methods, gated by realms.config.otp_mfa_enabled).
func (a *AuthClient) MFAVerifyOTP(ctx ctxpkg.Context, req MFAVerifyOTPRequest) (*Session, error) {
	return a.MFAVerify(ctx, MFAVerifyRequest{
		ChallengeToken: req.MFAToken,
		Code:           req.Presented,
		Method:         "otp_internal",
		OnBehalfOfIP:   req.OnBehalfOfIP,
	})
}

// MFAVerify completes an MFA challenge. Same response shape as Login.
func (a *AuthClient) MFAVerify(ctx ctxpkg.Context, req MFAVerifyRequest) (*Session, error) {
	tok, err := a.realm.platformToken.get(ctx)
	if err != nil {
		return nil, err
	}
	method := req.Method
	if method == "" {
		method = "totp"
	}
	body := map[string]any{
		"realm_id":        a.realm.realmID,
		"challenge_token": req.ChallengeToken,
		"code":            req.Code,
		"method":          method,
	}
	headers := map[string]string{}
	if req.OnBehalfOfIP != "" {
		headers["X-On-Behalf-Of-IP"] = req.OnBehalfOfIP
	}
	var resp Session
	if err := a.realm.http.do(ctx, requestOptions{
		Method:  "POST",
		Path:    "/auth/mfa/verify",
		Bearer:  tok,
		Body:    body,
		Headers: headers,
	}, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// Logout revokes a refresh token. If req.RefreshToken is empty, the
// caller's cookie / current session is used (server-side).
//
// When req.AccessToken is set AND a RevocationCache is configured on the
// Realm, the access token's jti is added to the cache on successful
// logout — bridging the gap between user logout and the access token's
// stateless natural expiry (ADR-041 follow-up). Failure to push to the
// cache does NOT fail the logout call; the server-side refresh
// revocation is the load-bearing operation.
func (a *AuthClient) Logout(ctx ctxpkg.Context, req *LogoutRequest) error {
	tok, err := a.realm.platformToken.get(ctx)
	if err != nil {
		return err
	}
	body := map[string]any{"realm_id": a.realm.realmID}
	if req != nil && req.RefreshToken != "" {
		body["refresh_token"] = req.RefreshToken
	}
	if err := a.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/auth/logout",
		Bearer: tok,
		Body:   body,
	}, nil); err != nil {
		return err
	}
	if req != nil && req.AccessToken != "" && a.realm.revocation != nil {
		if jti, exp, perr := peekJWTRevokeFields(req.AccessToken); perr == nil && jti != "" {
			_ = a.realm.revocation.Revoke(ctx, jti, exp)
		}
	}
	return nil
}

// RevokeSession removes a session by id. The caller identifies the
// user either via a user-bearer JWT (legacy / public-client realms) or
// via UserID + the SDK's platform token (BFF realms; ADR-041 §7).
func (a *AuthClient) RevokeSession(ctx ctxpkg.Context, req RevokeSessionRequest) error {
	bearer, headers, err := a.resolveOnBehalfOf(ctx, req.UserID, req.UserBearer, req.OnBehalfOfIP)
	if err != nil {
		return err
	}
	return a.realm.http.do(ctx, requestOptions{
		Method:  "DELETE",
		Path:    "/auth/sessions/" + url.PathEscape(req.SessionID),
		Bearer:  bearer,
		Headers: headers,
	}, nil)
}

// ListSessions iterates sessions for the user named in req. Public-
// client realms set UserBearer; BFF realms set UserID and the SDK
// attaches the platform token + X-On-Behalf-Of-User (ADR-041 §7).
func (a *AuthClient) ListSessions(ctx ctxpkg.Context, req ListSessionsRequest) iter.Seq2[*SessionInfo, error] {
	return func(yield func(*SessionInfo, error) bool) {
		bearer, headers, err := a.resolveOnBehalfOf(ctx, req.UserID, req.UserBearer, req.OnBehalfOfIP)
		if err != nil {
			yield(nil, err)
			return
		}
		var cursor string
		for {
			q := map[string]string{}
			if cursor != "" {
				q["cursor"] = cursor
			}
			var raw map[string]any
			if err := a.realm.http.do(ctx, requestOptions{
				Method:  "GET",
				Path:    "/auth/sessions",
				Bearer:  bearer,
				Query:   q,
				Headers: headers,
			}, &raw); err != nil {
				yield(nil, err)
				return
			}
			items, next, err := decodeSessionPage(raw)
			if err != nil {
				yield(nil, err)
				return
			}
			for i := range items {
				if !yield(&items[i], nil) {
					return
				}
			}
			if next == "" {
				return
			}
			cursor = next
		}
	}
}

func decodeSessionPage(raw map[string]any) ([]SessionInfo, string, error) {
	// Accept both the locked {items, next_cursor} envelope and the
	// legacy flat {sessions: [...]} shape (no pagination).
	itemsRaw, hasItems := raw["items"]
	if !hasItems {
		if alt, ok := raw["sessions"]; ok {
			itemsRaw = alt
		} else {
			return nil, "", &RealmError{Code: ErrCodeServerError, Message: "session list missing items"}
		}
	}
	arr, ok := itemsRaw.([]any)
	if !ok {
		return nil, "", &RealmError{Code: ErrCodeServerError, Message: "session list items not an array"}
	}
	out := make([]SessionInfo, 0, len(arr))
	for _, x := range arr {
		obj, ok := x.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, SessionInfo{
			ID:         strField(obj, "id"),
			CreatedAt:  strField(obj, "created_at"),
			LastUsedAt: strField(obj, "last_used_at"),
			UserAgent:  strField(obj, "user_agent"),
			IP:         strField(obj, "ip"),
		})
	}
	next, _ := raw["next_cursor"].(string)
	return out, next, nil
}

func strField(m map[string]any, k string) string {
	if v, ok := m[k].(string); ok {
		return v
	}
	return ""
}

// inferOrigin derives a value for the Origin header from realm metadata.
func inferOrigin(info *RealmInfo) string {
	if info == nil {
		return ""
	}
	host := info.Audience
	if host == "" {
		host = info.Domain
	}
	if host == "" {
		return ""
	}
	if strings.HasPrefix(host, "http://") || strings.HasPrefix(host, "https://") {
		return host
	}
	return "https://" + host
}

// MintMFAChallenge calls POST /auth/mfa/challenge to mint a step-up
// challenge token for the verified access token. Used by the middleware
// when an MFA-protected route receives a token that lacks fresh MFA
// proof. Returns ("", nil, error) when the server hasn't shipped the
// endpoint yet — the middleware downgrades to a generic 412 envelope
// without a pre-minted challenge.
func (a *AuthClient) MintMFAChallenge(ctx ctxpkg.Context, req MFAChallengeRequest) (string, []string, error) {
	headers := map[string]string{}
	if req.OnBehalfOfIP != "" {
		headers["X-On-Behalf-Of-IP"] = req.OnBehalfOfIP
	}
	var resp struct {
		MFAChallengeToken string   `json:"mfa_challenge_token"`
		Methods           []string `json:"methods"`
	}
	if err := a.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/auth/mfa/challenge",
		// Empty body — the bearer identifies user, session, and realm.
		Body:    map[string]string{},
		Bearer:  req.AccessToken,
		Headers: headers,
	}, &resp); err != nil {
		return "", nil, err
	}
	return resp.MFAChallengeToken, resp.Methods, nil
}

// resolveOnBehalfOf picks the bearer + headers for endpoints that act
// on a specific user. Exactly one of userID / userBearer must be set:
// userID → platform token + X-On-Behalf-Of-User (BFF mode, ADR-041 §7);
// userBearer → that JWT direct (legacy / public-client mode). When set,
// onBehalfOfIP rides as X-On-Behalf-Of-IP for per-IP rate-limit
// attribution (ADR-050 plan §8.2).
func (a *AuthClient) resolveOnBehalfOf(ctx ctxpkg.Context, userID, userBearer, onBehalfOfIP string) (string, map[string]string, error) {
	if userID == "" && userBearer == "" {
		return "", nil, &RealmError{
			Code:    ErrCodeBadRequest,
			Message: "set exactly one of UserID (BFF mode) or UserBearer (legacy mode)",
		}
	}
	if userID != "" && userBearer != "" {
		return "", nil, &RealmError{
			Code:    ErrCodeBadRequest,
			Message: "set exactly one of UserID or UserBearer, not both",
		}
	}
	headers := map[string]string{}
	if onBehalfOfIP != "" {
		headers["X-On-Behalf-Of-IP"] = onBehalfOfIP
	}
	if userID != "" {
		tok, err := a.realm.platformToken.get(ctx)
		if err != nil {
			return "", nil, err
		}
		headers["X-On-Behalf-Of-User"] = userID
		return tok, headers, nil
	}
	return userBearer, headers, nil
}
