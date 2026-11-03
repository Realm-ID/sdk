package realmid

// Device login (RFC 8628) for a partner BFF, SPEC §15. Two device-facing handlers (start, token) and four
// browser-facing ones (inspect, approve, deny, signout), all thin wiring over the issuer's device
// authorization (ADR-122). The device-login logic lives in the issuer; nothing here decides who may log in.

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ErrDeviceApprovalNotAllowed is the R86 sentinel for `403 device_approval_not_allowed` (SPEC §3.1, §15.3).
var ErrDeviceApprovalNotAllowed = errors.New("realmid: this person may not approve devices here")

const (
	grantDeviceCode      = "urn:ietf:params:oauth:grant-type:device_code"
	deviceClientIDMaxLen = 64
	deviceFormMaxBytes   = 64 << 10
)

// DefaultDevicePaths are the six paths Mount registers, relative to its prefix (SPEC §15.1).
var DefaultDevicePaths = struct{ Start, Token, Inspect, Approve, Deny, SignOut string }{
	Start: "/device/start", Token: "/device/token",
	Inspect: "/device/inspect", Approve: "/device/approve", Deny: "/device/deny", SignOut: "/device/signout",
}

// DeviceHandlerSet is the six handlers of the device flow (SPEC §15.1).
type DeviceHandlerSet struct {
	Start, Token                    http.Handler
	Inspect, Approve, Deny, SignOut http.Handler
}

// DeviceApprover is the person approving, from the verified access token (SPEC §15.3).
type DeviceApprover struct {
	UserID, TenantID, SessionID string
	Claims                      *Claims
}

// DeviceRequest is the issuer's inspect answer as the hooks see it (SPEC §15.3).
type DeviceRequest struct {
	ID, Status, ClientID, DeviceName, SubjectHint, ReportedIP, ObservedIP string
	CreatedAt, ExpiresAt                                                  time.Time
}

// DeviceSubject names the account an approval binds (SPEC §15.3).
type DeviceSubject struct {
	Ref, Kind, TenantID, Label string
}

// DeviceLoginResult is the issuer's self-case DeviceLoginResponse (SPEC §15.2, ADR-122 D6): the login
// fields plus the pinned tenant and session. It carries NO access token (R44).
type DeviceLoginResult struct {
	Status                string           `json:"status,omitempty"`
	SubjectType           string           `json:"subject_type,omitempty"`
	User                  *DeviceLoginUser `json:"user,omitempty"`
	RefreshToken          string           `json:"refresh_token"`
	RefreshExp            int64            `json:"refresh_exp,omitempty"`
	IdleTTL               int64            `json:"idle_ttl,omitempty"`
	Tenants               []map[string]any `json:"tenants,omitempty"`
	TenantID              string           `json:"tenant_id,omitempty"`
	SessionID             string           `json:"session_id,omitempty"`
	DeviceAuthorizationID string           `json:"device_authorization_id,omitempty"`
}

// DeviceLoginUser is the `user` object of a DeviceLoginResult.
type DeviceLoginUser struct {
	ID string `json:"id"`
}

// DeviceTokens is what the issuer minted at collection, passed to OnIssued (SPEC §15.2).
type DeviceTokens struct {
	SubjectType           string
	DeviceAuthorizationID string
	Bot                   *MintResult
	ServiceAccountID      string
	Self                  *DeviceLoginResult
}

// DeviceOptions configures DeviceHandlers (SPEC §15.3).
type DeviceOptions struct {
	VerificationURI             string
	OmitVerificationURIComplete bool
	CanApprove                  func(r *http.Request, approver DeviceApprover, req *DeviceRequest) bool
	OnBeforeApprove             func(r *http.Request, approver DeviceApprover, req DeviceRequest) error
	ResolveSubject              func(r *http.Request, approver DeviceApprover, req DeviceRequest, preview bool) (DeviceSubject, error)
	OnIssued                    func(r *http.Request, tokens DeviceTokens) (status int, body any, err error)
	ReplaceExistingSessions     bool
	DisableApproveStepUp        bool
	ApproveStepUp               *MFARule
	DeviceIP                    func(r *http.Request) string
}

type deviceSet struct {
	realm  *Realm
	opts   DeviceOptions
	stepUp *compiledMFARule // nil when the approve step-up is off
	maxAge time.Duration
}

// DeviceHandlers builds the device handler set (SPEC §15.1). It refuses to build, rather than return a
// half-built set, when VerificationURI is empty, CanApprove is nil or ApproveStepUp is invalid: a set
// without its gate would approve for everyone.
func DeviceHandlers(client *Realm, opts DeviceOptions) (*DeviceHandlerSet, error) {
	if client == nil {
		return nil, errors.New("realmid: DeviceHandlers needs a Realm")
	}
	if strings.TrimSpace(opts.VerificationURI) == "" {
		return nil, errors.New("realmid: DeviceOptions.VerificationURI is required (the partner's approval page)")
	}
	if opts.CanApprove == nil {
		return nil, errors.New("realmid: DeviceOptions.CanApprove is required: a device handler set without its gate would approve for everyone")
	}
	s := &deviceSet{realm: client, opts: opts, maxAge: 15 * time.Minute}
	if !opts.DisableApproveStepUp {
		rule := MFARule{Path: DefaultDevicePaths.Approve, RequireFresh: true}
		if opts.ApproveStepUp != nil {
			rule = *opts.ApproveStepUp
		}
		if err := ValidateMFARules([]MFARule{rule}); err != nil {
			return nil, err
		}
		compiled := compileMFARules([]MFARule{rule})
		if len(compiled) != 1 {
			return nil, errors.New("realmid: DeviceOptions.ApproveStepUp compiled to no rule")
		}
		s.stepUp = &compiled[0]
	}
	return &DeviceHandlerSet{
		Start: s.post(s.start), Token: s.post(s.token),
		Inspect: s.post(s.inspect), Approve: s.post(s.approve), Deny: s.post(s.deny), SignOut: s.post(s.signOut),
	}, nil
}

// Mount registers the six handlers under prefix at DefaultDevicePaths (SPEC §15.1). The four browser-facing
// ones must sit behind Realm.Middleware; start and token must be in its ExemptPaths.
func (s *DeviceHandlerSet) Mount(mux *http.ServeMux, prefix string) {
	prefix = strings.TrimRight(prefix, "/")
	mux.Handle(prefix+DefaultDevicePaths.Start, s.Start)
	mux.Handle(prefix+DefaultDevicePaths.Token, s.Token)
	mux.Handle(prefix+DefaultDevicePaths.Inspect, s.Inspect)
	mux.Handle(prefix+DefaultDevicePaths.Approve, s.Approve)
	mux.Handle(prefix+DefaultDevicePaths.Deny, s.Deny)
	mux.Handle(prefix+DefaultDevicePaths.SignOut, s.SignOut)
}

func (d *deviceSet) post(h func(http.ResponseWriter, *http.Request)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": map[string]any{"code": "bad_request", "message": "POST only"}})
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		h(w, r)
	})
}

// ---- device-facing (RFC 8628) ----

func rfcError(w http.ResponseWriter, status int, code, desc string) {
	body := map[string]any{"error": code}
	if desc != "" {
		body["error_description"] = desc
	}
	writeJSON(w, status, body)
}

func (d *deviceSet) deviceIP(r *http.Request) string {
	if d.opts.DeviceIP != nil {
		return d.opts.DeviceIP(r)
	}
	if h, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return h
	}
	return r.RemoteAddr
}

// wireCode is the code a RealmError states on the wire, including a server code the canonical union
// cannot carry (R-CLI2: user_suspended and the like keep their own name).
func wireCode(re *RealmError) string {
	if c := detailCode(re); c != "" {
		return c
	}
	return string(re.Code)
}

func (d *deviceSet) deviceError(w http.ResponseWriter, err error) {
	var re *RealmError
	if !errors.As(err, &re) {
		rfcError(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	status := re.HTTPStatus
	if status == 0 {
		status = http.StatusInternalServerError
	}
	if status == http.StatusNotFound {
		// The issuer has no such route (a partner pointed at an issuer older than 0.66.0): that is a bad
		// gateway, not a 404 for the device's own path.
		status = http.StatusBadGateway
	}
	switch re.Code {
	case ErrCodeAuthorizationPending, ErrCodeSlowDown, ErrCodeAccessDenied, ErrCodeExpiredToken:
		status = http.StatusBadRequest
	}
	if re.RetryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(int(re.RetryAfter.Seconds())))
	}
	rfcError(w, status, wireCode(re), re.Message)
}

func (d *deviceSet) start(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, deviceFormMaxBytes)
	if err := r.ParseForm(); err != nil {
		rfcError(w, http.StatusBadRequest, "invalid_request", "unreadable form")
		return
	}
	body := map[string]any{}
	for _, k := range []string{"client_id", "device_name", "subject_hint"} {
		if v := r.PostForm.Get(k); v != "" {
			body[k] = v
		}
	}
	if len(r.PostForm.Get("client_id")) > deviceClientIDMaxLen {
		rfcError(w, http.StatusBadRequest, "invalid_client_id", "client_id is at most 64 characters")
		return
	}
	ctx := r.Context()
	tok, err := d.realm.platformToken.get(ctx)
	if err != nil {
		d.deviceError(w, err)
		return
	}
	var resp struct {
		DeviceCode string `json:"device_code"`
		UserCode   string `json:"user_code"`
		ExpiresIn  int    `json:"expires_in"`
		Interval   int    `json:"interval"`
	}
	if err := d.realm.http.do(ctx, requestOptions{
		Method: "POST", Path: "/auth/device-authorizations", Bearer: tok, Body: body,
		Headers: map[string]string{"X-On-Behalf-Of-IP": d.deviceIP(r)},
	}, &resp); err != nil {
		d.deviceError(w, err)
		return
	}
	out := map[string]any{
		"device_code": resp.DeviceCode, "user_code": resp.UserCode, "verification_uri": d.opts.VerificationURI,
		"expires_in": resp.ExpiresIn, "interval": resp.Interval,
	}
	if !d.opts.OmitVerificationURIComplete {
		out["verification_uri_complete"] = d.verificationComplete(resp.UserCode)
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *deviceSet) verificationComplete(userCode string) string {
	u, err := url.Parse(d.opts.VerificationURI)
	if err != nil {
		return d.opts.VerificationURI
	}
	q := u.Query()
	q.Set("code", userCode)
	u.RawQuery = q.Encode()
	return u.String()
}

func (d *deviceSet) token(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, deviceFormMaxBytes)
	if err := r.ParseForm(); err != nil {
		rfcError(w, http.StatusBadRequest, "invalid_request", "unreadable form")
		return
	}
	if r.PostForm.Get("grant_type") != grantDeviceCode {
		rfcError(w, http.StatusBadRequest, "unsupported_grant_type", "grant_type must be "+grantDeviceCode)
		return
	}
	code := r.PostForm.Get("device_code")
	if code == "" {
		rfcError(w, http.StatusBadRequest, "invalid_request", "device_code is required")
		return
	}
	ctx := r.Context()
	tok, err := d.realm.platformToken.get(ctx)
	if err != nil {
		d.deviceError(w, err)
		return
	}
	body := map[string]any{"realm_id": d.realm.realmID, "grant_type": grantDeviceCode, "device_code": code}
	path := "/auth/token"
	if d.realm.split != nil {
		path = "/auth/token/partial"
	}
	var raw json.RawMessage
	if err := d.realm.http.do(ctx, requestOptions{
		Method: "POST", Path: path, Bearer: tok, Body: body,
		Headers: map[string]string{"X-On-Behalf-Of-IP": d.deviceIP(r)},
	}, &raw); err != nil {
		d.deviceError(w, err)
		return
	}
	var head struct {
		SubjectType           string `json:"subject_type"`
		DeviceAuthorizationID string `json:"device_authorization_id"`
		ServiceAccountID      string `json:"service_account_id"`
	}
	if err := json.Unmarshal(raw, &head); err != nil {
		rfcError(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	tokens := DeviceTokens{SubjectType: head.SubjectType, DeviceAuthorizationID: head.DeviceAuthorizationID}
	switch head.SubjectType {
	case "user":
		var self DeviceLoginResult
		if err := json.Unmarshal(raw, &self); err != nil {
			rfcError(w, http.StatusInternalServerError, "server_error", "")
			return
		}
		tokens.Self = &self
	case "service":
		var mr *MintResult
		if d.realm.split != nil {
			// A partial that fails to co-sign answers the device 500 and NO token (SPEC §15.6).
			mr, err = d.realm.finishPartial(ctx, raw)
			if err != nil {
				d.realm.logger.Error("realmid device poll: co-sign failed", "error", err.Error())
				rfcError(w, http.StatusInternalServerError, "server_error", "")
				return
			}
		} else {
			mr = &MintResult{}
			if err := json.Unmarshal(raw, mr); err != nil {
				rfcError(w, http.StatusInternalServerError, "server_error", "")
				return
			}
		}
		tokens.Bot, tokens.ServiceAccountID = mr, head.ServiceAccountID
	default:
		// Strict: a missing or unknown subject_type is never read as a bot (no token minted).
		d.realm.logger.Error("realmid device poll: unknown subject_type", "subject_type", head.SubjectType)
		rfcError(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	if d.opts.OnIssued != nil {
		status, out, err := d.opts.OnIssued(r, tokens)
		if err != nil {
			re := hookError(err)
			rfcError(w, re.HTTPStatus, wireCode(re), re.Message)
			return
		}
		if status == 0 {
			status = http.StatusOK
		}
		writeJSON(w, status, out)
		return
	}
	if tokens.Self != nil {
		writeJSON(w, http.StatusOK, tokens.Self)
		return
	}
	resp := map[string]any{"access_token": tokens.Bot.AccessToken, "token_type": "Bearer", "expires_in": tokens.Bot.ExpiresIn}
	if tokens.Bot.RefreshToken != "" {
		resp["refresh_token"] = tokens.Bot.RefreshToken
	}
	writeJSON(w, http.StatusOK, resp)
}

// ---- browser-facing ----

// DeviceRequestView is the inspect answer sent to the browser (BFF-SPEC camelCase). subjectHint and
// observedIp are deliberately absent (SPEC §15.2).
type DeviceRequestView struct {
	ID                      string `json:"id"`
	Status                  string `json:"status"`
	ClientID                string `json:"clientId,omitempty"`
	DeviceName              string `json:"deviceName,omitempty"`
	DeviceNameSource        string `json:"deviceNameSource"`
	ReportedIP              string `json:"reportedIp,omitempty"`
	ReportedIPSource        string `json:"reportedIpSource"`
	CreatedAt               string `json:"createdAt"`
	ExpiresAt               string `json:"expiresAt"`
	SubjectType             string `json:"subjectType,omitempty"`
	SubjectLabel            string `json:"subjectLabel,omitempty"`
	CollectedSessionID      string `json:"collectedSessionId,omitempty"`
	FailureReason           string `json:"failureReason,omitempty"`
	ReplaceExistingSessions bool   `json:"replaceExistingSessions"`
	StepUp                  bool   `json:"stepUp"`
}

// DeviceCodeRequest is the inspect, deny and signout body.
type DeviceCodeRequest struct {
	UserCode string `json:"userCode"`
}

// DeviceApproveRequest is the approve body. RevokeExistingSessions is a pointer so "not stated" is
// distinguishable from false (Q3: stated, never inferred).
type DeviceApproveRequest struct {
	UserCode               string `json:"userCode"`
	TenantID               string `json:"tenantId,omitempty"`
	RevokeExistingSessions *bool  `json:"revokeExistingSessions,omitempty"`
}

// DeviceApproveResponse is the approve answer.
type DeviceApproveResponse struct {
	ID          string `json:"id"`
	Status      string `json:"status"`
	SubjectType string `json:"subjectType"`
	ExpiresAt   string `json:"expiresAt"`
}

// DeviceDenyResponse is the deny answer.
type DeviceDenyResponse struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

// DeviceSignOutResponse is the signout answer: scope is "account" (bot) or "session" (self).
type DeviceSignOutResponse struct {
	SubjectType string `json:"subjectType"`
	Scope       string `json:"scope"`
}

// relayBrowserError writes an upstream or local error with both envelope levels: the code and message
// under `error`, every gate sibling (mfa_challenge_token, ...) beside it, Retry-After kept.
func relayBrowserError(w http.ResponseWriter, err error) {
	var re *RealmError
	if !errors.As(err, &re) {
		re = &RealmError{Code: ErrCodeServerError, Message: "server error", HTTPStatus: http.StatusInternalServerError}
	}
	status := re.HTTPStatus
	if status == 0 {
		status = http.StatusInternalServerError
	}
	body := map[string]any{"error": map[string]any{"code": wireCode(re), "message": re.Message}}
	for k, v := range re.Details {
		if k == "error" || k == "server_code" || k == "code" {
			continue
		}
		body[k] = v
	}
	if re.RetryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(int(re.RetryAfter.Seconds())))
	}
	writeJSON(w, status, body)
}

// forbiddenBody is THE answer for an unknown code and for a request the actor may not act on. Both paths
// write this constant so the two cannot be told apart (Q2).
func writeForbidden(w http.ResponseWriter) {
	writeJSON(w, http.StatusForbidden, map[string]any{"error": map[string]any{"code": "forbidden", "message": "forbidden"}})
}

func (d *deviceSet) fail(w http.ResponseWriter, err error) {
	var re *RealmError
	if errors.As(err, &re) && re.HTTPStatus == http.StatusForbidden && wireCode(re) == "forbidden" {
		writeForbidden(w)
		return
	}
	relayBrowserError(w, err)
}

// browserCtx is the shared prologue of the four browser routes: the approver from the verified claims
// (401 when the middleware did not run), the early CanApprove(nil) refusal, the body, and the context that
// carries the actor token as X-User-Token.
type browserCtx struct {
	ctx      context.Context
	approver DeviceApprover
	token    string
	body     DeviceApproveRequest
}

func (d *deviceSet) begin(w http.ResponseWriter, r *http.Request) (*browserCtx, bool) {
	claims, ok := ClaimsFrom(r.Context())
	authz := r.Header.Get("Authorization")
	if !ok || claims == nil || !strings.HasPrefix(strings.ToLower(authz), "bearer ") {
		relayBrowserError(w, &RealmError{Code: ErrCodeUnauthorized, Message: "sign in to continue", HTTPStatus: http.StatusUnauthorized})
		return nil, false
	}
	token := strings.TrimSpace(authz[len("bearer "):])
	b := &browserCtx{
		ctx:      WithUserToken(r.Context(), token),
		token:    token,
		approver: DeviceApprover{UserID: claims.Subject, TenantID: claims.TenantID, SessionID: claims.SessionID, Claims: claims},
	}
	if !d.opts.CanApprove(r, b.approver, nil) {
		relayBrowserError(w, &RealmError{Code: ErrCodeDeviceApprovalNotAllowed, Message: "you cannot approve devices here",
			HTTPStatus: http.StatusForbidden, Cause: ErrDeviceApprovalNotAllowed})
		return nil, false
	}
	buf, err := readJSON(r)
	if err != nil {
		relayBrowserError(w, &RealmError{Code: ErrCodeBadRequest, Message: err.Error(), HTTPStatus: http.StatusBadRequest})
		return nil, false
	}
	b.body.UserCode, _ = buf["userCode"].(string)
	b.body.TenantID, _ = buf["tenantId"].(string)
	if v, ok := buf["revokeExistingSessions"].(bool); ok {
		b.body.RevokeExistingSessions = &v
	}
	if b.body.UserCode == "" {
		relayBrowserError(w, &RealmError{Code: ErrCodeBadRequest, Message: "userCode is required", HTTPStatus: http.StatusBadRequest})
		return nil, false
	}
	return b, true
}

// issuer calls the issuer as the platform with the actor carried.
func (d *deviceSet) issuer(b *browserCtx, method, path string, body any, out any) error {
	tok, err := d.realm.platformToken.get(b.ctx)
	if err != nil {
		return err
	}
	return d.realm.http.do(b.ctx, requestOptions{Method: method, Path: path, Bearer: tok, Body: body}, out)
}

// lookup is the issuer inspect plus the second CanApprove call, with the request as the hooks see it.
func (d *deviceSet) lookup(r *http.Request, b *browserCtx) (DeviceRequest, map[string]any, error) {
	var raw json.RawMessage
	if err := d.issuer(b, "POST", "/auth/device-authorizations/inspect", map[string]any{"user_code": b.body.UserCode}, &raw); err != nil {
		return DeviceRequest{}, nil, err
	}
	m := unwrapData(raw)
	str := func(k string) string { v, _ := m[k].(string); return v }
	req := DeviceRequest{
		ID: str("device_authorization_id"), Status: str("status"), ClientID: str("client_id"), DeviceName: str("device_name"),
		SubjectHint: str("subject_hint"), ReportedIP: str("reported_ip"), ObservedIP: str("observed_ip"),
	}
	req.CreatedAt, _ = time.Parse(time.RFC3339, str("created_at"))
	req.ExpiresAt, _ = time.Parse(time.RFC3339, str("expires_at"))
	if !d.opts.CanApprove(r, b.approver, &req) {
		return DeviceRequest{}, nil, &RealmError{Code: ErrCodeForbidden, Message: "forbidden", HTTPStatus: http.StatusForbidden}
	}
	return req, m, nil
}

// unwrapData reads an issuer object that may arrive bare or under GoFr's {"data": ...} wrapper.
func unwrapData(raw []byte) map[string]any {
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	if inner, ok := m["data"].(map[string]any); ok {
		if _, bare := m["status"]; !bare {
			return inner
		}
	}
	if m == nil {
		m = map[string]any{}
	}
	return m
}

func (d *deviceSet) inspect(w http.ResponseWriter, r *http.Request) {
	b, ok := d.begin(w, r)
	if !ok {
		return
	}
	req, m, err := d.lookup(r, b)
	if err != nil {
		d.fail(w, err)
		return
	}
	str := func(k string) string { v, _ := m[k].(string); return v }
	view := DeviceRequestView{
		ID: req.ID, Status: req.Status, ClientID: req.ClientID, DeviceName: req.DeviceName,
		DeviceNameSource: "client_declared", ReportedIP: req.ReportedIP, ReportedIPSource: "partner",
		CreatedAt: str("created_at"), ExpiresAt: str("expires_at"),
		SubjectType: str("subject_type"), CollectedSessionID: str("collected_session_id"), FailureReason: str("failure_reason"),
		ReplaceExistingSessions: d.opts.ReplaceExistingSessions, StepUp: d.stepUp != nil,
	}
	if req.Status == "pending" {
		subj := DeviceSubject{Kind: "self", Label: "you"}
		if d.opts.ResolveSubject != nil {
			subj, err = d.opts.ResolveSubject(r, b.approver, req, true)
			if err != nil {
				relayBrowserError(w, hookError(err))
				return
			}
		}
		view.SubjectType, view.SubjectLabel = subjectTypeOf(subj.Kind), subj.Label
	}
	writeJSON(w, http.StatusOK, view)
}

// subjectTypeOf maps a DeviceSubject.Kind to the wire subject_type.
func subjectTypeOf(kind string) string {
	if kind == "service" {
		return "service"
	}
	return "user"
}

func (d *deviceSet) approve(w http.ResponseWriter, r *http.Request) {
	b, ok := d.begin(w, r)
	if !ok {
		return
	}
	if !d.stepUpFresh(w, r, b) {
		return
	}
	req, _, err := d.lookup(r, b)
	if err != nil {
		d.fail(w, err)
		return
	}
	if d.opts.OnBeforeApprove != nil {
		if err := d.opts.OnBeforeApprove(r, b.approver, req); err != nil {
			relayBrowserError(w, hookError(err))
			return
		}
	}
	subj := DeviceSubject{Ref: "self", Kind: "self"}
	if d.opts.ResolveSubject != nil {
		if subj, err = d.opts.ResolveSubject(r, b.approver, req, false); err != nil {
			relayBrowserError(w, hookError(err))
			return
		}
	}
	if subj.Ref == "" {
		subj.Ref = "self"
	}
	body := map[string]any{"user_code": b.body.UserCode, "subject_ref": subj.Ref}
	if tid := firstNonEmpty(subj.TenantID, b.body.TenantID); tid != "" {
		body["tenant_id"] = tid
	}
	// Q3: stated, never inferred. A browser that stated nothing sends nothing, and the issuer answers
	// 400 revoke_existing_sessions_required, which is relayed.
	switch {
	case d.opts.ReplaceExistingSessions:
		body["revoke_existing_sessions"] = true
	case b.body.RevokeExistingSessions != nil:
		body["revoke_existing_sessions"] = *b.body.RevokeExistingSessions
	}
	var raw json.RawMessage
	if err := d.issuer(b, "POST", "/auth/device-authorizations/approve", body, &raw); err != nil {
		d.fail(w, err)
		return
	}
	m := unwrapData(raw)
	str := func(k string) string { v, _ := m[k].(string); return v }
	writeJSON(w, http.StatusOK, DeviceApproveResponse{ID: str("device_authorization_id"), Status: str("status"),
		SubjectType: str("subject_type"), ExpiresAt: str("expires_at")})
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// stepUpFresh enforces the ADR-096 operation step-up on approve (Q5) with the evaluator and the 412
// envelope Realm.Middleware uses. It answers mfa_registration_required, not a verify challenge, for an
// approver with no confirmed factor (ADR-096 D4): the middleware's own gap is filed in sdk/TODO.md.
func (d *deviceSet) stepUpFresh(w http.ResponseWriter, r *http.Request, b *browserCtx) bool {
	if d.stepUp == nil {
		return true
	}
	verdict := evaluateMFAFreshness(b.approver.Claims, d.stepUp, d.maxAge)
	if verdict == nil {
		return true
	}
	code, token, methods := ErrCodeMFARequired, "", []string{"totp"}
	if list, err := d.realm.Auth.ListAuthenticators(b.ctx, ListAuthenticatorsRequest{}); err == nil && !hasConfirmed(list) {
		// Nothing to verify against: an ENROLL state, never a verify challenge with an empty token.
		code = ErrCodeMFARegistrationRequired
	} else {
		token, methods = d.realm.mintMFAChallenge(b.ctx, b.token)
	}
	msg := "MFA required for this resource"
	if code == ErrCodeMFARegistrationRequired {
		msg = "mfa registration required"
	}
	writeJSON(w, http.StatusPreconditionFailed, map[string]any{
		"error":               map[string]any{"code": string(code), "message": msg},
		"mfa_challenge_token": token,
		"methods":             methods,
		"max_age_seconds":     int(verdict.MaxAge / time.Second),
		"reason":              string(verdict.Reason),
	})
	return false
}

func hasConfirmed(l *AuthenticatorList) bool {
	if l == nil {
		return false
	}
	for _, a := range l.Authenticators {
		if a.Confirmed {
			return true
		}
	}
	return false
}

func (d *deviceSet) deny(w http.ResponseWriter, r *http.Request) {
	b, ok := d.begin(w, r)
	if !ok {
		return
	}
	var raw json.RawMessage
	if err := d.issuer(b, "POST", "/auth/device-authorizations/deny", map[string]any{"user_code": b.body.UserCode}, &raw); err != nil {
		d.fail(w, err)
		return
	}
	m := unwrapData(raw)
	str := func(k string) string { v, _ := m[k].(string); return v }
	writeJSON(w, http.StatusOK, DeviceDenyResponse{ID: str("device_authorization_id"), Status: str("status")})
}

func (d *deviceSet) signOut(w http.ResponseWriter, r *http.Request) {
	b, ok := d.begin(w, r)
	if !ok {
		return
	}
	req, m, err := d.lookup(r, b)
	if err != nil {
		d.fail(w, err)
		return
	}
	if req.Status != "collected" {
		relayBrowserError(w, &RealmError{Code: ErrCodeDeviceAuthorizationNotPending, HTTPStatus: http.StatusConflict,
			Message: "this device has not collected its sign-in, so there is nothing to sign out"})
		return
	}
	str := func(k string) string { v, _ := m[k].(string); return v }
	ref := str("subject_ref")
	if strings.HasPrefix(ref, "user:") {
		// Bot case: end ALL the account's sessions (Q7, DQ1). The bot lives in the approver's pinned tenant.
		sa := strings.TrimPrefix(ref, "user:")
		path := "/tenants/" + url.PathEscape(b.approver.TenantID) + "/service-accounts/" + url.PathEscape(sa) + "/revoke"
		if err := d.issuer(b, "POST", path, map[string]any{}, nil); err != nil {
			d.fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, DeviceSignOutResponse{SubjectType: "service", Scope: "account"})
		return
	}
	sid := str("collected_session_id")
	if sid == "" {
		relayBrowserError(w, &RealmError{Code: ErrCodeConflict, HTTPStatus: http.StatusConflict, Message: "no collected session to end"})
		return
	}
	if err := d.issuer(b, "DELETE", "/auth/sessions/"+url.PathEscape(sid), nil, nil); err != nil {
		d.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, DeviceSignOutResponse{SubjectType: "user", Scope: "session"})
}
