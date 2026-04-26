package realmid

import (
	"context"
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
}

// TenantRef is the abbreviated tenant info embedded in Session.Tenants.
type TenantRef struct {
	ID          string `json:"id"`
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
type Session struct {
	AccessToken  string      `json:"access_token"`
	RefreshToken string      `json:"refresh_token"`
	ExpiresIn    int         `json:"expires_in"`
	ExpiresAt    string      `json:"expires_at,omitempty"`
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
}

// LogoutRequest optionally targets a specific refresh token. If
// RefreshToken is empty, the server uses the cookie / current session.
type LogoutRequest struct {
	RefreshToken string
}

// SessionInfo is one entry in realm.Auth.ListSessions.
type SessionInfo struct {
	ID         string `json:"id"`
	CreatedAt  string `json:"created_at,omitempty"`
	LastUsedAt string `json:"last_used_at,omitempty"`
	UserAgent  string `json:"user_agent,omitempty"`
	IP         string `json:"ip,omitempty"`
}

// Login exchanges a provider token for a realm-scoped session. On a 412
// mfa_required, returns *RealmError{Code: mfa_required} with
// Details["mfa_challenge_token"] populated.
func (a *AuthClient) Login(ctx context.Context, req LoginRequest) (*Session, error) {
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
		"realm_id":       a.realm.realmID,
		"method":         string(method),
		"provider_token": req.ProviderToken,
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
	return &resp, nil
}

// Token rotates a refresh token, optionally switching tenants and
// merging custom claims into the minted access token.
func (a *AuthClient) Token(ctx context.Context, req TokenRequest) (*MintResult, error) {
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

// MFAVerify completes an MFA challenge. Same response shape as Login.
func (a *AuthClient) MFAVerify(ctx context.Context, req MFAVerifyRequest) (*Session, error) {
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
	var resp Session
	if err := a.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/auth/mfa/verify",
		Bearer: tok,
		Body:   body,
	}, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// Logout revokes a refresh token. If req.RefreshToken is empty, the
// caller's cookie / current session is used (server-side).
func (a *AuthClient) Logout(ctx context.Context, req *LogoutRequest) error {
	tok, err := a.realm.platformToken.get(ctx)
	if err != nil {
		return err
	}
	body := map[string]any{"realm_id": a.realm.realmID}
	if req != nil && req.RefreshToken != "" {
		body["refresh_token"] = req.RefreshToken
	}
	return a.realm.http.do(ctx, requestOptions{
		Method: "POST",
		Path:   "/auth/logout",
		Bearer: tok,
		Body:   body,
	}, nil)
}

// RevokeSession removes a session by id. Uses the user's bearer token
// (per SPEC §4.5 — this is a user-context call).
func (a *AuthClient) RevokeSession(ctx context.Context, sessionID, userBearer string) error {
	return a.realm.http.do(ctx, requestOptions{
		Method: "DELETE",
		Path:   "/auth/sessions/" + url.PathEscape(sessionID),
		Bearer: userBearer,
	}, nil)
}

// ListSessions iterates sessions for the user identified by userBearer.
// Per SPEC §4.6 this uses the user's bearer JWT, NOT the platform token.
func (a *AuthClient) ListSessions(ctx context.Context, userBearer string) iter.Seq2[*SessionInfo, error] {
	return func(yield func(*SessionInfo, error) bool) {
		var cursor string
		for {
			q := map[string]string{}
			if cursor != "" {
				q["cursor"] = cursor
			}
			var raw map[string]any
			if err := a.realm.http.do(ctx, requestOptions{
				Method: "GET",
				Path:   "/auth/sessions",
				Bearer: userBearer,
				Query:  q,
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
