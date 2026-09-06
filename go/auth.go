package realmid

import (
	ctxpkg "context"
	"errors"
	"fmt"
	"iter"
	"net/url"
	"strconv"
	"strings"
)

// AuthClient implements realm.Auth.* per SPEC §4.
type AuthClient struct {
	realm *Realm
}

// LoginMethod is the upstream identity provider for a login call.
// "firebase", "google", and "microsoft" have working issuer-side verifiers.
type LoginMethod string

const (
	LoginFirebase  LoginMethod = "firebase"
	LoginGoogle    LoginMethod = "google"
	LoginMicrosoft LoginMethod = "microsoft"
)

// Canonical /auth/login grant_type values (ADR-051). The SDK sends these
// on the wire instead of the deprecated `method` field (Sunset 2026-08-01).
const (
	grantProviderToken = "provider_token"
	// grantOTP is the OTP login grant. ADR-071 §4 renamed the wire value
	// "otp_internal" → "otp" (direct cutover — the issuer no longer accepts the
	// old name). Safe because otp_login_enabled is default-off, so no live
	// consumer was on the old grant.
	grantOTP = "otp"
	// grantPassword is the ADR-104 native username/password grant. Reserved on
	// the wire since ADR-051 and refused with 400 unknown_method until ADR-104
	// supplied the verifier.
	grantPassword = "password"
)

// otpMethodMFA is the /auth/mfa/verify method arm for an OTP second factor —
// renamed "otp_internal" → "otp" in the ADR-071 §4 cutover.
const otpMethodMFA = "otp"

// OTP delivery modes.
//
// The withholding rule is what distinguishes them: `view_bff` returns the
// plaintext to the CALLER, while `email` and `sms` have RealmID deliver it to
// the SUBJECT and the caller receives nothing.
//
// ⚠️ For `purpose=login` that rule decides WHO MAY BE AUTHENTICATED (ADR-103
// D3/D4), not merely how the code travels:
//
//	view_bff  the PARTNER reads it  -> kind=service subjects ONLY, owner-gated
//	sms       the SUBJECT reads it  -> ANY kind
//	email     refused — a login code mailed to an address turns mailbox access
//	          into account access with no second factor
//
// There is NO FALLBACK between the RI-delivered modes: asking for `sms` and
// silently receiving mail would substitute the channel the subject controls,
// which is the whole property. A subject with no address of the requested kind
// is a 400 and the issue FAILS.
const (
	// DeliveryModeViewBFF returns the plaintext to the authorized caller
	// (ADR-071 §4). The default, and what an omitted delivery_mode has always
	// meant.
	DeliveryModeViewBFF = "view_bff"
	// DeliveryModeEmail has RealmID email the code to the subject
	// (ADR-095 D7). Refused for purpose=login.
	DeliveryModeEmail = "email"
	// DeliveryModeSMS has RealmID text the code to the subject's phone
	// (ADR-103). Allowed for purpose=login, for a principal of ANY kind.
	DeliveryModeSMS = "sms"
)

// LoginRequest carries the inputs to realm.Auth.Login. Custom claims
// are NOT accepted on login (SPEC §4.1) — refresh-token identity only.
type LoginRequest struct {
	Method        LoginMethod
	ProviderToken string
	Origin        string // optional override of the SDK-derived Origin header
	// DeviceName, when set, is sent as the X-Device-Name header and recorded
	// on the created session as a human-readable device label (e.g. a CLI
	// hostname), surfaced in Sessions.List so a user can tell sessions apart
	// for revocation (ADR-062). Optional; the issuer caps/sanitizes it.
	DeviceName string

	// TenantID disambiguates when the user is a member of multiple
	// tenants in the realm. When empty and the user has >1 tenants, the
	// auth server returns the tenant list (no tokens) so the caller can
	// re-POST with the chosen tenant_id.
	TenantID string

	// RolePermissions is the permission list the holder's ROLE confers, in YOUR
	// vocabulary, used to narrow a user-API-key token's permissions_cap claim to
	// this org (ADR-100 D16/D5).
	//
	// Supply it from your own role→permission map. RealmID stores no partner
	// catalog and will not resolve it for you (D17): a scope string is opaque
	// here.
	//
	// OPTIONAL, and omitting it can only widen TOWARD the stored cap, never past
	// it. The claim minted is stored_cap ∩ RolePermissions; omit the field and
	// the stored cap travels unnarrowed, which is exactly the pre-ADR-100
	// behaviour. A wrong or hostile list therefore cannot widen a key —
	// A ∩ B ⊆ A for every B — which is what makes a caller-asserted value
	// acceptable at all. It is audited as ASSERTED and unverified, the same
	// convention SourceOrgID uses.
	//
	// Ignored for a token that is not key-derived, and ignored for an UNCAPPED
	// key, whose claim stays ABSENT whatever you send (D7).
	//
	// An empty INTERSECTION is 403, not an empty claim (D8), and the narrowing
	// is per-org — so a multi-org key can mint in one org and be refused in
	// another. The error names the org.
	RolePermissions []string
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
	// MFARequired reports whether this membership demands an MFA step
	// before a usable access token is minted. The issuer sets it per
	// tenant on the login tenant list (authsvc.TenantMembership); a BFF
	// uses it to tell an unminted-because-MFA login apart from an
	// unminted-because-multi-tenant one.
	MFARequired bool `json:"mfa_required,omitempty"`
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
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	// RefreshExp is the absolute wall-clock expiry (unix seconds) of the
	// returned refresh token — the instant past which it can no longer be
	// rotated, taking the min of the rolling TTL, the ADR-054 scheduled
	// cutoff, and the ADR-058 absolute session cap (SPEC §4.1). It is 0 when
	// the issuer does not surface it (pre-refresh_exp issuers); callers that
	// size a session from it must fall back to their own ceiling on 0.
	RefreshExp int64 `json:"refresh_exp,omitempty"`
	// IdleTTL is the sliding-window idle-timeout duration (seconds) for the
	// session (ADR-070). Each authenticated use slides the window forward by
	// IdleTTL; the session dies if idle past it. 0 (absent / omitempty) means
	// no idle timeout — callers must treat 0 as "disabled", not "expire now".
	IdleTTL   int64  `json:"idle_ttl,omitempty"`
	ExpiresAt string `json:"expires_at,omitempty"`
	TenantID  string `json:"tenant_id,omitempty"`
	Role      string `json:"role,omitempty"`
	// InitiatedByUserID is the owner/admin who minted the login OTP that
	// produced this service-account session (ADR-071 §8 attribution). Empty for
	// human/provider logins and M2M sessions. Surfaced from the issuer's
	// `initiated_by_user_id` session provenance; omitempty so a human session
	// keeps it off the wire.
	InitiatedByUserID string      `json:"initiated_by_user_id,omitempty"`
	User              UserSummary `json:"user"`
	Tenants           []TenantRef `json:"tenants"`
	// TenantChoiceRequired (ADR-092 D5, the picker) reports that the caller
	// holds more than one ACTIVE membership in a realm that requires
	// single-tenant membership and must give the extras up. The REQUIREMENT
	// itself is a different decision — ADR-092 D4, the realm config knob
	// `single_tenant_membership`, default false — and both are cited here
	// because a reader who follows D5 alone looking for the knob will not
	// find it there. The login SUCCEEDED — an access
	// token is minted and the refresh token is issued as usual — so this is a
	// reconciliation prompt, not an auth failure: refusing the login would
	// strand exactly the users the drain exists to resolve. Settle it with
	// Realm.Me.ChooseTenant. Absent (false) on every realm that has the knob
	// off, which is every realm until a partner turns it on.
	TenantChoiceRequired bool `json:"tenant_choice_required,omitempty"`
	// TenantChoices are the memberships the picker may choose between.
	TenantChoices []TenantChoice `json:"tenant_choices,omitempty"`
}

// TenantChoice is one option in the ADR-092 D5 single-tenant picker.
type TenantChoice struct {
	TenantID    string `json:"tenant_id"`
	DisplayName string `json:"display_name"`
	// IsOwner marks a membership that CANNOT be given up: releasing it would
	// leave the tenant ownerless and `tenants.owner_user_id` is NOT NULL. The
	// client should not offer it — the server refuses it regardless — and the
	// way out is an ADR-076 ownership transfer first.
	IsOwner bool `json:"is_owner"`
}

// NeedsTenantChoice reports whether the issuer returned a tenant
// picker instead of a session: more than one membership and no access
// token minted. Callers (typically a BFF) surface the choice to the
// end user and re-POST /auth/login with `tenant_id` set.
func (s *Session) NeedsTenantChoice() bool {
	if s == nil {
		return false
	}
	return s.AccessToken == "" && len(s.Tenants) > 1
}

// SelectTenant resolves the final (tenant_id, role) pair the BFF
// should persist for a session, given an optional caller-preferred
// tenant. Preference order: preferred > Session.TenantID >
// Session.Tenants[0].ID. The role is looked up from Session.Tenants
// when the resolved tenant has an entry there; otherwise
// Session.Role is returned as-is.
func (s *Session) SelectTenant(preferred string) (tenantID, role string) {
	if s == nil {
		return preferred, ""
	}
	tenantID = preferred
	if tenantID == "" {
		tenantID = s.TenantID
	}
	if tenantID == "" && len(s.Tenants) > 0 {
		tenantID = s.Tenants[0].ID
	}
	role = s.Role
	for _, t := range s.Tenants {
		if t.ID == tenantID {
			role = t.Role
			break
		}
	}
	return tenantID, role
}

// TokenRequest is realm.Auth.Token's input — refresh + tenant_id +
// optional access-token customClaims (SPEC §4.2).
type TokenRequest struct {
	RefreshToken string
	TenantID     string
	CustomClaims map[string]any

	// Scope is ADR-097 GRANTED AUTHORITY: the partner's OWN scope strings,
	// minted into the token's `scope` claim and read back by ScopesFrom /
	// ScopeAllows / ScopePolicy.
	//
	// This is the operand the enforcement layer in scope.go evaluates. Supply
	// it from YOUR role->scope map: RealmID stores no partner catalog (ADR-097
	// D17) and a scope string is opaque here — shape is validated, meaning
	// never is.
	//
	// A LIST, not the wire's space-delimited string, on purpose. The SDK joins
	// with " " and refuses an entry that could not survive it, because a space
	// inside one entry is not a parse error on the wire — it SPLITS one scope
	// into two and mints authority you did not ask for. An unsendable entry is
	// ErrInvalidScope, raised before the request leaves.
	//
	// Accepted on /auth/token ONLY, never on /auth/login: the ADR-041 escort
	// runs on this route for every refresh class, so a confidential backend is
	// structurally always in the path and a user cannot self-assert a scope.
	//
	// OPTIONAL. Empty and absent are the same request — unlike RolePermissions,
	// an empty scope carries no instruction. The issuer bounds the list against
	// the realm's user_api_keys.max_permission_strings /
	// max_permission_string_len (400 too_many_scopes / scope_too_long) and
	// refuses it outright on a service-class refresh (400 scope_not_supported).
	//
	// Where the token is ALSO user-API-key-derived, the minted claim is the
	// intersection with permissions_cap; see RolePermissions for that narrowing.
	Scope []string

	// RolePermissions is the permission list the holder's ROLE confers, in YOUR
	// vocabulary, used to narrow a user-API-key token's permissions_cap claim to
	// this org — on REFRESH as well as login (ADR-100 D16/D18).
	//
	// Supply it on EVERY mint. A user-API-key session IS refreshable, so a
	// refresh that omits the list comes back WIDER than the token it replaces,
	// silently. Supply it from your own role→permission map. RealmID stores no partner
	// catalog and will not resolve it for you (D17): a scope string is opaque
	// here.
	//
	// OPTIONAL, and omitting it can only widen TOWARD the stored cap, never past
	// it. The claim minted is stored_cap ∩ RolePermissions; omit the field and
	// the stored cap travels unnarrowed, which is exactly the pre-ADR-100
	// behaviour. A wrong or hostile list therefore cannot widen a key —
	// A ∩ B ⊆ A for every B — which is what makes a caller-asserted value
	// acceptable at all. It is audited as ASSERTED and unverified, the same
	// convention SourceOrgID uses.
	//
	// Ignored for a token that is not key-derived, and ignored for an UNCAPPED
	// key, whose claim stays ABSENT whatever you send (D7).
	//
	// An empty INTERSECTION is 403, not an empty claim (D8).
	//
	// ⚠️ ADR-105 changed that refusal's shape. The narrowing used to be per-org,
	// so the same key could mint in one org and be refused in another and the
	// error named which. A key now has exactly ONE org, so the refusal is
	// unconditional and the error carries no tenant id — there is no "try
	// another org" recovery to point at.
	RolePermissions []string

	// ProductRoles is the PARTNER's own role name(s) for this principal
	// (ADR-102) — carried onto the access token and read by no RealmID gate.
	//
	// Normally you do NOT set this by hand: configure Config.ProductRoles and
	// Login/CompleteLogin populate it on every mint. The field is here because
	// the mint accepts it.
	//
	// ⚠️ `Scope` carries authority; this carries a NAME. Do not branch
	// authorization on it, and do not confuse it with the `role` claim, which is
	// RealmID's OWN vocabulary and a trusted authorization lookup key on the
	// direct-bearer lane.
	//
	// A LIST on the wire too, unlike Scope: partner role names are not
	// constrained to the RFC 6749 §3.3 charset and a legitimate "Regional
	// Manager" must survive. Bounded by CONSTANTS, not realm config — at most 16
	// entries of at most 64 bytes, each non-empty, valid UTF-8 and free of
	// control characters (400 too_many_product_roles / product_role_too_long /
	// invalid_product_role).
	//
	// Empty and absent are the same request: an empty list mints no claim rather
	// than [].
	ProductRoles []string
}

// MintResult is realm.Auth.Token's response.
type MintResult struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	// RefreshExp is the absolute wall-clock expiry (unix seconds) of the
	// rotated refresh token (SPEC §4.1). 0 when the issuer does not surface
	// it; see Session.RefreshExp.
	RefreshExp int64 `json:"refresh_exp,omitempty"`
	// IdleTTL is the sliding-window idle-timeout duration (seconds) for the
	// session (ADR-070). 0 (absent / omitempty) means no idle timeout; see
	// Session.IdleTTL.
	IdleTTL int64 `json:"idle_ttl,omitempty"`
	// SubjectType is the minted token's subject class (SPEC §4.2):
	// "user", "service", or "platform" (ADR-051). The issuer returns it
	// on /auth/token for every refresh class; TenantID and Role are
	// populated only when SubjectType == "user".
	SubjectType string `json:"subject_type"`
	TenantID    string `json:"tenant_id"`
	Role        string `json:"role"`
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
	ID string `json:"id"`
	// CreatedAt / LastUsedAt are unix seconds — the issuer serializes session
	// timestamps as JSON numbers (sessionDTO.CreatedAt/LastSeenAt). Mistyped
	// as string through go/v0.21.0; fixed in v0.22.0.
	//
	// The wire field for last-used is `last_seen_at` (issuer
	// httpapi.sessionDTO.LastSeenAt), NOT `last_used_at`. The Go field keeps
	// its LastUsedAt name for API stability; only the json tag maps to the
	// server's `last_seen_at`. (Through v0.22.0 the tag read `last_used_at`,
	// so LastUsedAt always decoded to zero.)
	CreatedAt  int64  `json:"created_at,omitempty"`
	LastUsedAt int64  `json:"last_seen_at,omitempty"`
	UserAgent  string `json:"user_agent,omitempty"`
	IP         string `json:"ip,omitempty"`
	// DeviceName is the human-readable device label recorded at login via
	// the X-Device-Name header (e.g. a CLI hostname), if any (ADR-062).
	DeviceName string `json:"device_name,omitempty"`
}

// ListSessionsRequest selects the user whose sessions to list and how
// to attest the call.
//
// Exactly one of UserID or UserBearer must be set:
//   - UserID:     BFF mode. The SDK uses its cached platform token as
//     the bearer and sends X-On-Behalf-Of-User: <UserID>.
//     Required when realm.config.require_bff_login=true
//     (ADR-041 §7).
//     The id ALONE is not an identity — since issuer v0.66.0 a bare
//     X-On-Behalf-Of-User is refused with 401 x_user_token_required —
//     so the call must also carry the user's verified access JWT via
//     realmid.WithUserToken(ctx, jwt). The SDK refuses locally when it
//     is missing rather than issuing a request that cannot succeed.
//   - UserBearer: legacy / public-client mode. The user's access JWT
//     rides as Authorization: Bearer. Subject is read from
//     the JWT.
//
// OnBehalfOfIP, when set, is forwarded as X-On-Behalf-Of-IP so the
// issuer's per-IP rate limits see the SPA's IP, not the BFF's egress
// (ADR-050 plan §8.2).
type ListSessionsRequest struct {
	UserID       string
	UserBearer   string
	OnBehalfOfIP string

	// Limit is the server page size (SPEC §7). Optional; <=0 sends nothing and
	// the issuer applies its own default of 50.
	//
	// It does NOT bound the iteration — ListSessions still follows next_cursor
	// to the end. What it bounds is one round trip, which is the only reason a
	// caller would set it and the only way a test can force a page boundary
	// without creating fifty-one sessions.
	//
	// Added for parity: ts (`listSessions(jwt, {limit})`) and Java
	// (`Paginated` opts) have always taken one, so Go's cursor loop was the
	// only one that could not be exercised below the server default — which is
	// exactly the code path the ts 0.37.0 truncation bug lived in.
	Limit int
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
//
// # ⚠️ BREAKING (ADR-102 D10): Login MINTS now
//
// Once the tenant is settled, Login follows /auth/login with a /auth/token mint
// and the ProductRoles handler runs there. It is a CHANGED entry point, not a
// new one: a separate LoginAndMint would have been non-breaking and would have
// left the default wrong — every consumer who never knew to re-mint would keep
// the role-blind token, which is the exact failure this removes.
//
// Two branches, and they are the two /auth/login already has:
//
//   - EXACTLY ONE TENANT: mint immediately. The caller gets a fully-minted
//     session in one call, as today.
//   - SEVERAL TENANTS (NeedsTenantChoice): do NOT mint. The tenant list and the
//     refresh token come back; your app presents the choice — your labels, your
//     role names, your decision — and calls CompleteLogin on selection.
//
// ⚠️ Do NOT settle the multi-tenant branch with SelectTenant. It falls back to
// Tenants[0] when nothing is preferred, so wiring the branch through it would
// mint for an ARBITRARY tenant and resolve THAT tenant's roles — a silent wrong
// answer, not an error. The auto-pick is for a caller that has already decided.
//
// What moves for you: the 412 mfa_required gate now surfaces from Login where it
// previously surfaced from your own Token call.
//
// The session /auth/login created is NOT discarded when the mint fails. It rides
// on a *LoginMintError, which is the ADR-102 OQ8 RECOVERY ANCHOR — read that
// type's doc for why it is on the error rather than in the return value.
//
// Costs, accepted: one extra issuer round trip per login on the happy path, and
// one extra refresh-token ROTATION (the token login minted inline is
// immediately superseded). Both are per-login, not per-request.
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
	if label := headerSafeDeviceName(req.DeviceName); label != "" {
		headers["X-Device-Name"] = label
	}

	method := req.Method
	if method == "" {
		method = LoginFirebase
	}
	// ADR-051: send the canonical `grant_type` + `provider` pair, not the
	// deprecated `method` field (Sunset 2026-08-01). Auth.Login is always a
	// provider-token exchange — LoginMethod only ever names an IdP
	// (firebase/google/microsoft) — so the grant is fixed and the method
	// string carries through as the provider hint. The issuer's
	// legacyMethodToGrant shim is now unused by this SDK on the login path.
	body := map[string]any{
		"realm_id":   a.realm.realmID,
		"grant_type": grantProviderToken,
		"provider":   string(method),
		// Field name is "token" on the wire (see issuer httpapi/auth.go
		// loginReq.Token) — the IdP credential for grant_type=provider_token.
		"token": req.ProviderToken,
	}
	if req.TenantID != "" {
		body["tenant_id"] = req.TenantID
	}
	if req.RolePermissions != nil {
		body["role_permissions"] = req.RolePermissions
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
	// ADR-102 D10 — mint once the tenant is settled. See the doc comment.
	if tenantID := settledTenant(&resp); tenantID != "" {
		if err := a.mintProductRoles(ctx, &resp, FlowLogin, tenantID, req.RolePermissions); err != nil {
			// The session is HANDED BACK on the error, not discarded — see
			// LoginMintError. It is the ADR-102 OQ8 recovery anchor.
			return nil, &LoginMintError{Session: &resp, TenantID: tenantID, Err: err}
		}
	}
	return &resp, nil
}

// settledTenant returns the tenant a login resolved to, or "" when the caller
// must still choose (ADR-102 D10).
//
// "Settled" means the issuer picked one: a flat tenant_id on the response, or
// exactly one membership. It deliberately does NOT fall back to Tenants[0] on a
// multi-tenant login — that is what SelectTenant does for a caller who has
// already decided, and using it here would mint for an arbitrary org and resolve
// that org's roles.
func settledTenant(s *Session) string {
	if s == nil {
		return ""
	}
	if s.TenantID != "" {
		return s.TenantID
	}
	if len(s.Tenants) == 1 {
		return s.Tenants[0].ID
	}
	return ""
}

// CompleteLogin finishes a multi-tenant login: it runs the ProductRoles handler
// for the CHOSEN tenant and mints through /auth/token, updating the session in
// place (ADR-102 D10).
//
// Call it when Session.NeedsTenantChoice() reported true and your app has
// presented the choice. Passing a tenantID the session does not list is refused
// locally rather than sent — a tenant the user does not hold is a caller bug,
// and the issuer's answer for it (invalid_credentials) would read as a login
// failure.
//
// Safe to call on an already-minted single-tenant session: it re-mints for the
// named tenant, which is the tenant-switch operation.
func (a *AuthClient) CompleteLogin(ctx ctxpkg.Context, s *Session, tenantID string, rolePermissions []string) error {
	if s == nil {
		return errors.New("realmid: CompleteLogin needs a session")
	}
	if tenantID == "" {
		return errors.New("realmid: CompleteLogin needs a tenant_id — the multi-tenant " +
			"branch does not auto-pick, and SelectTenant's Tenants[0] fallback would " +
			"mint for an arbitrary org")
	}
	known := len(s.Tenants) == 0
	for _, t := range s.Tenants {
		if t.ID == tenantID {
			known = true
			break
		}
	}
	if !known {
		return fmt.Errorf("realmid: tenant %s is not one of this session's memberships", tenantID)
	}
	return a.mintProductRoles(ctx, s, FlowTenantChoice, tenantID, rolePermissions)
}

// mintProductRoles runs the handler and re-mints the session through
// /auth/token, updating it in place.
//
// # When it does nothing, and why that is the shape
//
// With NO handler configured and an access token ALREADY in hand, it returns
// immediately. A round trip that could only reproduce the token we are holding
// is pure cost, and skipping it is what keeps D10 from taxing every consumer who
// never adopts the claim.
//
// The remaining condition — no handler, no access token — is exactly the guard
// RealmID's own BFF hand-rolled (`if sess.AccessToken == ""`,
// api/internal/handlers/handlers.go), with a comment explaining that the issuer
// skips its inline single-tenant mint under MFA and that the 412 gate "fires on
// /auth/token, which login never calls". That is SDK documentation living in a
// consumer. Once Login mints, the guard collapses and the gate surfaces from
// Login for EVERY consumer, not just the one that knew to go looking — which
// ADR-102 D10 names as this decision's acceptance test.
func (a *AuthClient) mintProductRoles(ctx ctxpkg.Context, s *Session, flow AuthFlow, tenantID string, rolePermissions []string) error {
	// OnIdentityResolved fires FIRST, and above the short-circuit below on
	// purpose: a hook-only consumer must still be told, and a hook that fired
	// after the resolvers would be useless to the partner it exists for — their
	// Scopes handler reads the row this hook writes.
	//
	// The role lookup is HOISTED from the post-mint update further down. Same
	// read, no second source of truth.
	role := ""
	for _, t := range s.Tenants {
		if t.ID == tenantID {
			role = t.Role
			break
		}
	}
	if err := a.realm.fireIdentityResolved(ctx, IdentityResolvedEvent{
		Flow:        flow,
		TenantID:    tenantID,
		UserID:      s.User.ID,
		Role:        role,
		Email:       s.User.Email,
		DisplayName: s.User.DisplayName,
	}); err != nil {
		return err
	}
	if a.realm.cfg.ProductRoles == nil && a.realm.cfg.Scopes == nil && s.AccessToken != "" {
		return nil
	}
	roles, err := a.realm.resolveProductRoles(ctx, tenantID, s.User.ID)
	if err != nil {
		// The handler's error, surfaced as a *ProductRolesError and NOT mapped
		// into a RealmError. The session stays intact so the caller can recover
		// — see Login's doc comment.
		return err
	}
	// ADR-097 granted authority, resolved on the SAME lanes and by the same
	// rules. A Config.Scopes that worked on refresh but not here would be the
	// mirror of the bug this whole seam exists to close, and would be found the
	// same way: by a partner, in production.
	scopes, err := a.realm.resolveScopes(ctx, tenantID, s.User.ID)
	if err != nil {
		return err
	}
	mint, err := a.Token(ctx, TokenRequest{
		RefreshToken:    s.RefreshToken,
		TenantID:        tenantID,
		ProductRoles:    roles,
		Scope:           scopes,
		RolePermissions: rolePermissions,
	})
	if err != nil {
		return err
	}
	s.AccessToken = mint.AccessToken
	s.RefreshToken = mint.RefreshToken
	s.ExpiresIn = mint.ExpiresIn
	if mint.RefreshExp != 0 {
		s.RefreshExp = mint.RefreshExp
	}
	s.TenantID = tenantID
	for _, t := range s.Tenants {
		if t.ID == tenantID {
			s.Role = t.Role
			break
		}
	}
	return nil
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
	// Keyed on nil, not len — an EMPTY supplied list is a real instruction ("this
	// role confers nothing here"), and the issuer answers it with a 403 naming
	// the org. Folding it into "not supplied" would silently mint the unnarrowed
	// cap instead, which is the widest possible reading of the narrowest possible
	// input.
	if req.RolePermissions != nil {
		body["role_permissions"] = req.RolePermissions
	}
	// Keyed on EMPTINESS, not nil (ADR-102 D11 rule 2) — the opposite of
	// RolePermissions directly above, and the difference is the whole point.
	// An empty role_permissions is an instruction ("this role confers nothing
	// here"); an empty product_roles is not, because absent and empty must mean
	// the same thing. Every token issued before ADR-102 has no claim at all, so
	// a reader handles absence regardless, and minting [] would invent a third
	// state for them to interpret.
	if len(req.ProductRoles) > 0 {
		body["product_roles"] = req.ProductRoles
	}
	// Keyed on emptiness, not nil — the inverse of RolePermissions above, and
	// for the stated reason: parseScope trims and returns nil for "", so an
	// empty scope IS an absent one and a "scope": "" on the wire could not mean
	// anything. Refused before the request leaves, so a bad entry never spends
	// (and rotates away) the refresh token.
	scopeWire, err := scopeWireValue(req.Scope)
	if err != nil {
		return nil, err
	}
	if scopeWire != "" {
		body["scope"] = scopeWire
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
	// ADR-051: canonical grant_type, not the deprecated `method` field.
	body := map[string]any{
		"realm_id":   a.realm.realmID,
		"grant_type": grantOTP,
		"identifier": req.Identifier,
		"presented":  req.Presented,
	}
	if req.TenantID != "" {
		body["tenant_id"] = req.TenantID
	}
	// No role_permissions here, deliberately. The field narrows a USER API KEY's
	// stored cap (ADR-100 D5), and an OTP login is not key-derived — there is no
	// cap for it to intersect with, so accepting one would be a knob that does
	// nothing. Add it only if a grant appears that can produce a capped token.
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
	// ADR-102 D10 — an OTP login is a login: once the tenant is settled the
	// derived-claims handlers run and the session is re-minted. Added when the
	// AST-derived lane guard found this lane uncovered; the defect report that
	// prompted the guard named only MFAVerify, and a hand-written list had said
	// "three call sites" for months.
	if tenantID := settledTenant(&resp); tenantID != "" {
		if err := a.mintProductRoles(ctx, &resp, FlowOTP, tenantID, nil); err != nil {
			return nil, &LoginMintError{Session: &resp, TenantID: tenantID, Err: err}
		}
	}
	return &resp, nil
}

// PasswordLoginRequest is the input to AuthClient.PasswordLogin (ADR-104).
type PasswordLoginRequest struct {
	// Identifier is an email, an E.164 phone, or a USERNAME.
	//
	// It is CLASSIFIED ONCE by the issuer, never tried as several kinds in
	// turn: a fallthrough would let a string valid as two kinds resolve
	// differently depending on which store answered first — a nondeterministic
	// identity. The three grammars are disjoint by construction.
	Identifier string
	Presented  string
	Origin     string
	// TenantID is OPTIONAL for an email or phone and LOAD-BEARING for a
	// USERNAME.
	//
	// Usernames are unique per TENANT, not per realm — `alice` in two orgs is
	// routinely two people — so a username alone does not identify a principal.
	// The issuer resolves the tenant as: this field if present, else the tenant
	// bound to the request's host. EXPLICIT WINS, including when the two
	// disagree: a partner BFF is server-side and its Origin is its own, not the
	// end user's org, so an Origin-wins rule would make BFF-fronted username
	// login unimplementable without one host per org.
	//
	// Neither source yielding one is `400 tenant_required` — a NAMED code, not a
	// credential failure, because it is an integration mistake rather than a
	// wrong password. The SDK does NOT guess a tenant and does not fall back to
	// Tenants[0].
	TenantID string
}

// PasswordLogin signs a principal in with a native username/password
// credential (ADR-104).
//
// Every failure collapses to `401 invalid_credentials` — an unknown handle, a
// user with no credential row, a wrong password, a stored algorithm this issuer
// cannot verify. Reporting "this account has no password set" separately would
// tell a prober which accounts are password-enabled.
//
// ⚠️ `403 password_must_change` is DIFFERENT and is not collapsed: the password
// was CORRECT, but an administrator set it, so it is an assertion rather than a
// proof and the holder must replace it through `PUT /me/password` first. Saying
// "invalid credentials" there would send them to a reset flow that does not
// exist.
//
// A `kind=service` account cannot hold a password: its lanes are `api_key` and
// `otp`/`view_bff` (ADR-071), and a service account with a human-chosen secret
// is a shared password by another name.
//
// Like OTPLogin, this takes no RolePermissions: that field narrows a USER API
// KEY's stored cap (ADR-100 D5) and a password login is not key-derived, so
// accepting one would be a knob that does nothing.
func (a *AuthClient) PasswordLogin(ctx ctxpkg.Context, req PasswordLoginRequest) (*Session, error) {
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
		"grant_type": grantPassword,
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
	// ADR-102 D10 — same mint rule as Login: once the tenant is settled the
	// product-roles handler runs and the session is re-minted. A password login
	// is a login, so it must not be the one lane that returns a role-blind token.
	if tenantID := settledTenant(&resp); tenantID != "" {
		if err := a.mintProductRoles(ctx, &resp, FlowPassword, tenantID, nil); err != nil {
			return nil, &LoginMintError{Session: &resp, TenantID: tenantID, Err: err}
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
		Method:         otpMethodMFA,
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
		"realm_id":            a.realm.realmID,
		"mfa_challenge_token": req.ChallengeToken,
		"code":                req.Code,
		"method":              method,
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
	// The same normalisation every other session-producing lane does. MFAVerify
	// did none of it and returned the raw response, which is why the mint below
	// had no user id to resolve against even once it was added.
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
	// ADR-102 D10 — a step-up is the point at which the token the user carries
	// for the rest of the session is issued, so it is the LAST lane that may
	// hand back a claim-blind one. Without this, a partner who requires MFA has
	// every human denied by their own ScopePolicy gate immediately after
	// passing the second factor — the worst possible moment for it.
	if tenantID := settledTenant(&resp); tenantID != "" {
		if err := a.mintProductRoles(ctx, &resp, FlowMFAVerify, tenantID, nil); err != nil {
			return nil, &LoginMintError{Session: &resp, TenantID: tenantID, Err: err}
		}
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
	bearer, headers, err := a.resolveOnBehalfOf(ctx, req.UserID, req.UserBearer, req.OnBehalfOfIP, true)
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
		bearer, headers, err := a.resolveOnBehalfOf(ctx, req.UserID, req.UserBearer, req.OnBehalfOfIP, true)
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
			if req.Limit > 0 {
				q["limit"] = strconv.Itoa(req.Limit)
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
			CreatedAt:  intField(obj, "created_at"),
			LastUsedAt: intField(obj, "last_seen_at"),
			UserAgent:  strField(obj, "user_agent"),
			IP:         strField(obj, "ip"),
			DeviceName: strField(obj, "device_name"),
		})
	}
	next, _ := raw["next_cursor"].(string)
	return out, next, nil
}

// headerSafeDeviceName removes the characters an HTTP header field value cannot
// carry (C0 controls and DEL). It is NOT a policy check: the issuer's
// sanitizeDeviceName strips the same class AND caps the value at 120
// characters, and the cap stays there — a client-side copy of a server policy
// drifts the day either side changes.
//
// It exists because the transport refuses such a value outright: net/http fails
// the request with "invalid header field value" (measured, not assumed), as
// undici and the JDK client do, so a label containing a newline never arrived
// sanitized — the whole login failed with an error naming the network rather
// than the argument. Stripping here yields exactly the value the server would
// have stored.
func headerSafeDeviceName(s string) string {
	return strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s))
}

func strField(m map[string]any, k string) string {
	if v, ok := m[k].(string); ok {
		return v
	}
	return ""
}

// intField reads a unix-seconds timestamp from a generically-decoded JSON
// object. encoding/json decodes numbers into float64 for map[string]any, so
// that is the live path; the other cases are defensive (a json.Number-mode
// decoder, or a server that ever emits the value as a numeric string).
func intField(m map[string]any, k string) int64 {
	switch v := m[k].(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	case string:
		n, _ := strconv.ParseInt(v, 10, 64)
		return n
	}
	return 0
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
// idAssertsIdentity distinguishes the two meanings the id carries on the wire.
// On the sessions + MFA-self routes it is an IDENTITY pivot, which the issuer
// resolves through derivePlatformActsOnUser and refuses without X-User-Token.
// On the OTP routes it is a DOMAIN PARAMETER — the OTP subject, read straight
// off the header (issuer internal/httpapi/otp.go: "NOT an authz pivot") — and
// requiring a user token there would break a call the issuer accepts.
func (a *AuthClient) resolveOnBehalfOf(ctx ctxpkg.Context, userID, userBearer, onBehalfOfIP string, idAssertsIdentity bool) (string, map[string]string, error) {
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
		// Since issuer v0.66.0 a BARE X-On-Behalf-Of-User is NOT an identity:
		// it was an unauthenticated user id that any holder of a realm's
		// platform key could use to act as any user in that realm, so the
		// issuer now answers 401 x_user_token_required and only the VERIFIED
		// X-User-Token asserts who the caller is. The id survives as
		// attribution alongside it.
		//
		// Refuse here rather than issuing a request that is certain to 401
		// (measured against a live issuer, 2026-08-21): the server's error
		// cannot say which SDK call site forgot the token, and this one can.
		if idAssertsIdentity && userTokenFrom(ctx) == "" {
			return "", nil, &RealmError{
				Code: ErrCodeBadRequest,
				Message: "BFF mode needs the user's access JWT as well as UserID: " +
					"call with realmid.WithUserToken(ctx, accessJWT) — the issuer refuses " +
					"a bare X-On-Behalf-Of-User with 401 x_user_token_required (v0.66.0)",
			}
		}
		tok, err := a.realm.platformToken.get(ctx)
		if err != nil {
			return "", nil, err
		}
		headers["X-On-Behalf-Of-User"] = userID
		return tok, headers, nil
	}
	return userBearer, headers, nil
}
